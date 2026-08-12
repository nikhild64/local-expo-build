import fs from 'fs';
import path from 'path';
import { execaSync } from 'execa';
import { log } from '../util/log';
import { easGraphql, resolveEasAuth } from './eas/api';

export interface BumpVersionOpts {
  cwd: string;
  profile?: string;
  skipEas?: boolean;
}

export interface BumpVersionResult {
  versionName: string;
  versionCode: number | null;
}

/**
 * The exact query eas-cli's `build:version:get` runs (packages/eas-cli/src/
 * graphql/queries/AppVersionQuery.ts). Using the same query as a fallback
 * means a changed eas-cli text output can never strand the version bump.
 */
const LATEST_APP_VERSION_QUERY = `
  query LatestAppVersion($appId: String!, $platform: AppPlatform!, $applicationIdentifier: String!) {
    app { byId(appId: $appId) {
      id
      latestAppVersionByPlatformAndApplicationIdentifier(
        platform: $platform
        applicationIdentifier: $applicationIdentifier
      ) {
        id
        storeVersion
        buildVersion
      }
    } }
  }`;

/**
 * Parses the numeric versionCode out of `eas build:version:get` output.
 *
 * eas-cli prints `Android versionCode - 1` (with the value in bold ANSI when
 * colors are forced), and older versions used other separators. We strip ANSI
 * first, then accept any of `-`, `–`, or `:` before the number. Returns null
 * when nothing parseable is found — the caller then falls back to the EAS
 * GraphQL API instead of giving up on the whole bump.
 */
export function parseEasCliVersionCode(stdout: string): number | null {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const patterns = [
    /Android\s+versionCode\s*[-–:]\s*(\d+)/i,
    /versionCode\s*[-–:]\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m) {
      const parsed = parseInt(m[1], 10);
      if (Number.isInteger(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Reads the current versionCode straight from EAS's GraphQL API — the same
 * query eas-cli uses. Works without eas-cli installed; only needs EXPO_TOKEN
 * or an `eas login` session. Returns null when the app has no remote version
 * yet (or no auth is available); throws when the API call itself fails so the
 * caller can decide how loudly to report it.
 */
async function queryEasLatestVersionCode(
  projectId: string,
  applicationId: string
): Promise<number | null> {
  const auth = resolveEasAuth();
  if (!auth) {
    log.dim('No EXPO_TOKEN or eas login session — skipping GraphQL version fetch.');
    return null;
  }
  const data = await easGraphql<any>(
    LATEST_APP_VERSION_QUERY,
    { appId: projectId, platform: 'ANDROID', applicationIdentifier: applicationId },
    auth
  );
  const buildVersion =
    data?.app?.byId?.latestAppVersionByPlatformAndApplicationIdentifier?.buildVersion;
  if (buildVersion === null || buildVersion === undefined) return null;
  const parsed = parseInt(String(buildVersion), 10);
  if (!Number.isInteger(parsed)) {
    log.dim(`EAS returned an unexpected buildVersion "${buildVersion}" — treating as no remote version.`);
    return null;
  }
  return parsed;
}

/**
 * Resolves the next versionCode from EAS's remote version source, three
 * attempts in order of fidelity:
 *
 *  1. `eas build:version:get` — the CLI is authoritative when it succeeds;
 *     parsing is hardened against ANSI colors and separator drift.
 *  2. EAS GraphQL API (`latestAppVersionByPlatformAndApplicationIdentifier`)
 *     — kicks in when the CLI is missing/crashed or its text output changed
 *     shape. Needs no eas-cli install, only EXPO_TOKEN / `eas login`.
 *  3. Seed the remote version from the local versionCode (`build:version:set`)
 *     for a project that has never built on EAS — only when eas-cli is present
 *     and explicitly failed.
 *
 * Returns null when nothing could be resolved (the caller falls back to a
 * plain local versionCode bump, preserving the pre-existing behavior).
 */
async function resolveEasRemoteVersionCode(opts: {
  cwd: string;
  profile: string;
  projectId: string;
  applicationId: string | undefined;
  currentVersion: string;
  gradle: string;
}): Promise<number | null> {
  // 1) eas-cli `build:version:get`. Wrapped in try/catch because a missing or
  //    crashing eas-cli (ENOENT, timeout) must degrade to the fallbacks below
  //    instead of hard-failing the whole version bump.
  let cliExitCode: number | undefined;
  let cliStdout = '';
  try {
    const result = execaSync(
      'eas',
      ['build:version:get', '--platform', 'android', '--profile', opts.profile, '--non-interactive'],
      { cwd: opts.cwd, encoding: 'utf8', reject: false, timeout: 30_000 }
    );
    cliExitCode = result.exitCode;
    cliStdout = result.stdout || '';
  } catch (err: any) {
    log.dim(`eas build:version:get unavailable (${err?.message || err}).`);
  }

  if (cliExitCode === 0) {
    const remote = parseEasCliVersionCode(cliStdout);
    if (remote !== null) {
      const code = remote + 1;
      log.ok(`EAS versionCode: ${remote} → ${code}`);
      return code;
    }
    log.dim('`eas build:version:get` output changed shape — querying the EAS GraphQL API directly.');
  }

  // 2) GraphQL API fallback — also covers the eas-cli-missing case.
  if (opts.applicationId) {
    try {
      const remote = await queryEasLatestVersionCode(opts.projectId, opts.applicationId);
      if (remote !== null) {
        const code = remote + 1;
        log.ok(`EAS versionCode (via GraphQL): ${remote} → ${code}`);
        return code;
      }
    } catch (err: any) {
      log.dim(`EAS GraphQL version fetch failed: ${err?.message || err}`);
    }
  }

  // 3) First build on EAS — `build:version:get` fails with a non-zero exit.
  //    Seed the remote version with the local versionCode first, then bump
  //    from it. A successful (exit 0) run that found nothing means "no remote
  //    versions configured", which is handled above — seeding there would
  //    clobber the remote with a stale local code.
  if (cliExitCode !== undefined && cliExitCode !== 0) {
    const cur = opts.gradle.match(/\bversionCode\s+(\d+)/);
    const localCode = cur ? parseInt(cur[1], 10) : null;
    if (localCode == null) {
      log.warn('Could not read local versionCode; falling back to local bump');
      return null;
    }
    try {
      execaSync(
        'eas',
        [
          'build:version:set',
          '--platform',
          'android',
          '--profile',
          opts.profile,
          '--version-code',
          String(localCode),
          '--version-name',
          opts.currentVersion,
          '--non-interactive',
        ],
        { cwd: opts.cwd, encoding: 'utf8', timeout: 30_000 }
      );
      const code = localCode + 1;
      log.ok(`Seeded EAS versionCode ${localCode} (first build) → ${code}`);
      return code;
    } catch (err: any) {
      log.warn('EAS version set failed. (Ensure project is linked and authenticated)');
      return null;
    }
  }

  log.warn('Could not parse EAS versionCode; falling back to local bump');
  return null;
}

/**
 * 1. Bump patch in app.json + package.json
 * 2. Fetch versionCode from EAS (unless skipEas), increment, write into android/app/build.gradle
 */
export async function bumpVersion({
  cwd,
  profile = 'production',
  skipEas = false,
}: BumpVersionOpts): Promise<BumpVersionResult> {
  const appJsonPath = path.join(cwd, 'app.json');
  const pkgJsonPath = path.join(cwd, 'package.json');
  const gradlePath = path.join(cwd, 'android', 'app', 'build.gradle');

  if (!fs.existsSync(appJsonPath)) throw new Error(`app.json not found at ${appJsonPath}`);
  const gradleExists = fs.existsSync(gradlePath);
  if (!gradleExists) {
    log.dim('android/app/build.gradle not present — bumping app.json only (iOS-only build or prebuild not run).');
  }

  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const currentVersion: string = appJson.expo?.version;
  if (!currentVersion || currentVersion.split('.').length !== 3) {
    throw new Error(
      `Unexpected version in app.json: "${currentVersion}" — expected x.y.z with integer segments (e.g. 1.2.3). ` +
        `Pre-release / build-metadata tags (e.g. 1.0.0-rc.1) are not supported by the version bump.`
    );
  }
  const parts = currentVersion.split('.');
  const patch = parseInt(parts[2], 10);
  if (!Number.isInteger(patch) || String(patch) !== parts[2]) {
    throw new Error(
      `Unexpected patch segment "${parts[2]}" in app.json version "${currentVersion}" — ` +
        `expected a plain integer (no leading zeros, no pre-release tags).`
    );
  }
  parts[2] = String(patch + 1);
  const nextVersion = parts.join('.');
  appJson.expo.version = nextVersion;
  fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n', 'utf8');
  log.ok(`app.json version: ${currentVersion} → ${nextVersion}`);

  if (fs.existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    pkg.version = nextVersion;
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    log.ok(`package.json version: → ${nextVersion}`);
  }

  let nextCode: number | null = null;
  let gradle = gradleExists ? fs.readFileSync(gradlePath, 'utf8') : '';
  const projectId: string | undefined = appJson.expo?.extra?.eas?.projectId;
  if (!skipEas && projectId) {
    const easJsonPath = path.join(cwd, 'eas.json');
    let isRemote = false;
    if (fs.existsSync(easJsonPath)) {
      try {
        const easJson = JSON.parse(fs.readFileSync(easJsonPath, 'utf8'));
        if (easJson.cli?.appVersionSource === 'remote') {
          isRemote = true;
        }
      } catch (e) {}
    }

    if (!isRemote) {
      log.dim('EAS appVersionSource is not "remote" (default is local). Skipping remote fetch.');
    } else {
      log.info(`Fetching EAS versionCode (profile: ${profile})...`);
      nextCode = await resolveEasRemoteVersionCode({
        cwd,
        profile,
        projectId,
        applicationId: appJson.expo?.android?.package,
        currentVersion,
        gradle,
      });
    }
  }

  if (nextCode == null && gradleExists) {
    const cur = gradle.match(/\bversionCode\s+(\d+)/);
    nextCode = cur ? parseInt(cur[1], 10) + 1 : 1;
    log.dim(`Local versionCode bump: → ${nextCode}`);
  }
  if (gradleExists) {
    gradle = gradle.replace(/(\bversionCode\s+)\d+/, `$1${nextCode}`);
    gradle = gradle.replace(/(\bversionName\s+")[^"]*"/, `$1${nextVersion}"`);
    fs.writeFileSync(gradlePath, gradle, 'utf8');
    log.ok(`build.gradle: versionCode=${nextCode}, versionName="${nextVersion}"`);
  }

  return { versionName: nextVersion, versionCode: nextCode };
}

import fs from 'fs';
import path from 'path';
import { execaSync } from 'execa';
import { log } from '../util/log';
import { easGraphql, resolveEasAuth } from './eas/api';
import { invalidateExpoConfigCache, readExpoConfig } from './expoConfig';
import {
  canEditExpoConfig,
  findDynamicConfigFile,
  hasDynamicConfigProperty,
  hasStaticLiteralInDynamicConfig,
  readStaticLiteralFromDynamicConfig,
  setDynamicConfigValue,
} from './expoConfigEdit';

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
 * or an `eas login` session.
 *
 * Returns `queried: true` when EAS confirmed the app record exists (so a null
 * `versionCode` distinguishes "no remote builds yet" from "couldn't query").
 */
async function queryEasLatestVersionCode(
  projectId: string,
  applicationId: string
): Promise<{ queried: boolean; versionCode: number | null }> {
  const auth = resolveEasAuth();
  if (!auth) {
    log.dim('No EXPO_TOKEN or eas login session — skipping GraphQL version fetch.');
    return { queried: false, versionCode: null };
  }
  const data = await easGraphql<any>(
    LATEST_APP_VERSION_QUERY,
    { appId: projectId, platform: 'ANDROID', applicationIdentifier: applicationId },
    auth
  );
  if (!data?.app?.byId) {
    return { queried: false, versionCode: null };
  }
  const buildVersion =
    data.app.byId.latestAppVersionByPlatformAndApplicationIdentifier?.buildVersion;
  if (buildVersion === null || buildVersion === undefined) {
    return { queried: true, versionCode: null };
  }
  const parsed = parseInt(String(buildVersion), 10);
  if (!Number.isInteger(parsed)) {
    log.dim(`EAS returned an unexpected buildVersion "${buildVersion}" — treating as no remote version.`);
    return { queried: true, versionCode: null };
  }
  return { queried: true, versionCode: parsed };
}

const CREATE_APP_VERSION_MUTATION = `
  mutation CreateAppVersionMutation($appVersionInput: AppVersionInput!) {
    appVersion {
      createAppVersion(appVersionInput: $appVersionInput) { id }
    }
  }`;

/**
 * Updates EAS's remote Android versionCode via the GraphQL `createAppVersion`
 * mutation (the same mutation `eas build:version:set` executes after its
 * interactive prompt; `eas build:version:set` itself has no non-interactive
 * `--version-code`/`--version-name` CLI flags).
 */
async function pushEasRemoteVersionCode(opts: {
  projectId: string;
  applicationId: string | undefined;
  versionName: string;
  versionCode: number;
}): Promise<boolean> {
  if (!opts.applicationId) {
    log.dim('Missing Android applicationId — cannot update EAS remote versionCode.');
    return false;
  }
  const auth = resolveEasAuth();
  if (!auth) {
    log.dim('No EXPO_TOKEN or eas login session — cannot update EAS remote versionCode.');
    return false;
  }
  try {
    await easGraphql(
      CREATE_APP_VERSION_MUTATION,
      {
        appVersionInput: {
          appId: opts.projectId,
          platform: 'ANDROID',
          applicationIdentifier: opts.applicationId,
          storeVersion: opts.versionName,
          buildVersion: String(opts.versionCode),
        },
      },
      auth
    );
    return true;
  } catch (err: any) {
    log.dim(`EAS GraphQL version set failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * Resolves the next versionCode from EAS's remote version source, three
 * attempts in order of fidelity:
 *
 *  1. `eas build:version:get` — the CLI is authoritative when it succeeds;
 *     parsing is hardened against ANSI colors and separator drift.
 *  2. EAS GraphQL API (`latestAppVersionByPlatformAndApplicationIdentifier`)
 *     — kicks in when the CLI is missing, timed out, crashed, or its text
 *     output changed shape. Needs no eas-cli install, only EXPO_TOKEN / `eas login`.
 *  3. Seed the remote version from the local versionCode via GraphQL
 *     `createAppVersion` for a project that has never built on EAS yet.
 *
 * If a remote versionCode exists and `localCode > remote`, we reconcile by
 * pushing `localCode + 1` to EAS remote via GraphQL and returning `localCode + 1`
 * so local `build.gradle` stays monotonic and synced with EAS.
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
  nextVersion: string;
  gradle: string;
}): Promise<number | null> {
  const curMatch = opts.gradle.match(/\bversionCode\s+(\d+)/);
  const localCode = curMatch ? parseInt(curMatch[1], 10) : null;

  // 1) eas-cli `build:version:get`. Wrapped in try/catch because a missing,
  //    timed-out, or crashing eas-cli must degrade to the GraphQL fallback
  //    instead of hard-failing the whole version bump.
  let cliExitCode: number | undefined;
  let cliStdout = '';
  try {
    const result = execaSync(
      'eas',
      ['build:version:get', '--platform', 'android', '--profile', opts.profile, '--non-interactive'],
      { cwd: opts.cwd, encoding: 'utf8', reject: false, timeout: 15_000 }
    );
    if ((result as any).timedOut) {
      log.dim('eas build:version:get timed out — falling back to the EAS GraphQL API.');
    } else {
      cliExitCode = result.exitCode;
      cliStdout = result.stdout || '';
    }
  } catch (err: any) {
    log.dim(`eas build:version:get unavailable (${err?.message || err}).`);
  }

  let remote: number | null = null;
  let viaGraphql = false;
  let graphqlConfirmedEmpty = false;

  if (cliExitCode === 0) {
    remote = parseEasCliVersionCode(cliStdout);
    if (remote === null && !/no remote versions/i.test(cliStdout)) {
      log.dim('`eas build:version:get` output changed shape — querying the EAS GraphQL API directly.');
    }
  }

  // 2) GraphQL API fallback — also covers the eas-cli-missing and timeout cases.
  if (remote === null && opts.applicationId) {
    try {
      const gql = await queryEasLatestVersionCode(opts.projectId, opts.applicationId);
      if (gql.versionCode !== null) {
        remote = gql.versionCode;
        viaGraphql = true;
      } else if (gql.queried) {
        graphqlConfirmedEmpty = true;
      }
    } catch (err: any) {
      log.dim(`EAS GraphQL version fetch failed: ${err?.message || err}`);
    }
  }

  if (remote !== null) {
    if (localCode !== null && localCode > remote) {
      const code = localCode + 1;
      log.warn(
        `Local versionCode (${localCode}) is greater than EAS remote (${remote}) — setting remote to ${code} and syncing locally.`
      );
      const pushed = await pushEasRemoteVersionCode({
        projectId: opts.projectId,
        applicationId: opts.applicationId,
        versionName: opts.nextVersion,
        versionCode: code,
      });
      if (pushed) {
        log.ok(`EAS remote versionCode set to ${code} (local ${localCode} → ${code})`);
      } else {
        log.warn(`Could not update EAS remote versionCode to ${code} right now; syncing local to ${code}.`);
      }
      return code;
    }

    const code = remote + 1;
    log.ok(`EAS versionCode${viaGraphql ? ' (via GraphQL)' : ''}: ${remote} → ${code}`);
    return code;
  }

  // 3) First build on EAS — confirmed via GraphQL (null remote version) or CLI
  //    non-zero exit. Seed remote with localCode via GraphQL `createAppVersion`
  //    (never call interactive-only `eas build:version:set`).
  if (graphqlConfirmedEmpty || (cliExitCode !== undefined && cliExitCode !== 0)) {
    if (localCode == null) {
      log.warn('Could not read local versionCode; falling back to local bump');
      return null;
    }
    const seeded = await pushEasRemoteVersionCode({
      projectId: opts.projectId,
      applicationId: opts.applicationId,
      versionName: opts.currentVersion,
      versionCode: localCode,
    });
    if (seeded) {
      const code = localCode + 1;
      log.ok(`Seeded EAS versionCode ${localCode} (first build) → ${code}`);
      return code;
    }
    log.warn('EAS version set failed. (Ensure project is linked and authenticated via `eas login` or `EXPO_TOKEN`)');
    return null;
  }

  log.warn('Could not parse EAS versionCode; falling back to local bump');
  return null;
}

/**
 * 1. Bump patch in Expo config (`app.config.*` / `app.json`) + `package.json`
 * 2. Fetch versionCode from EAS (unless skipEas), increment, write into android/app/build.gradle
 */
export async function bumpVersion({
  cwd,
  profile = 'production',
  skipEas = false,
}: BumpVersionOpts): Promise<BumpVersionResult> {
  const dynamicPath = findDynamicConfigFile(cwd);
  const appJsonPath = path.join(cwd, 'app.json');
  const pkgJsonPath = path.join(cwd, 'package.json');
  const gradlePath = path.join(cwd, 'android', 'app', 'build.gradle');

  const hasAppJson = fs.existsSync(appJsonPath);
  if (!dynamicPath && !hasAppJson) {
    throw new Error(`app.json not found at ${appJsonPath}`);
  }
  const gradleExists = fs.existsSync(gradlePath);
  if (!gradleExists) {
    log.dim('android/app/build.gradle not present — bumping config only (iOS-only build or prebuild not run).');
  }

  let appJson: any = null;
  if (hasAppJson) {
    appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  }
  let pkgJson: any = null;
  if (fs.existsSync(pkgJsonPath)) {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  }

  const resolved = readExpoConfig(cwd);
  const configLabel = dynamicPath ? path.basename(dynamicPath) : 'app.json';
  const staticDynamicVersion = dynamicPath ? readStaticLiteralFromDynamicConfig(dynamicPath, ['version']) : undefined;
  const currentVersion: string | undefined =
    staticDynamicVersion ?? resolved?.config?.version ?? appJson?.expo?.version ?? (dynamicPath ? pkgJson?.version : undefined);
  if (!currentVersion || currentVersion.split('.').length !== 3) {
    throw new Error(
      `Unexpected version in ${configLabel}: "${currentVersion}" — expected x.y.z with integer segments (e.g. 1.2.3). ` +
        `Pre-release / build-metadata tags (e.g. 1.0.0-rc.1) are not supported by the version bump.`
    );
  }
  const parts = currentVersion.split('.');
  const patch = parseInt(parts[2], 10);
  if (!Number.isInteger(patch) || String(patch) !== parts[2]) {
    throw new Error(
      `Unexpected patch segment "${parts[2]}" in ${configLabel} version "${currentVersion}" — ` +
        `expected a plain integer (no leading zeros, no pre-release tags).`
    );
  }
  parts[2] = String(patch + 1);
  const nextVersion = parts.join('.');

  if (dynamicPath) {
    if (hasStaticLiteralInDynamicConfig(dynamicPath, ['version'])) {
      setDynamicConfigValue(dynamicPath, ['version'], nextVersion);
      log.ok(`${path.basename(dynamicPath)} version: ${currentVersion} → ${nextVersion}`);
    } else if (appJson?.expo?.version) {
      appJson.expo.version = nextVersion;
      fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n', 'utf8');
      log.ok(`app.json version: ${currentVersion} → ${nextVersion}`);
    } else if (!hasDynamicConfigProperty(dynamicPath, ['version']) && canEditExpoConfig(cwd)) {
      setDynamicConfigValue(dynamicPath, ['version'], nextVersion);
      log.ok(`${path.basename(dynamicPath)} version: ${currentVersion} → ${nextVersion}`);
    } else {
      log.dim(`${path.basename(dynamicPath)} computes version dynamically — updating package.json only.`);
    }
    invalidateExpoConfigCache(cwd);
  } else {
    appJson.expo = appJson.expo || {};
    appJson.expo.version = nextVersion;
    fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n', 'utf8');
    invalidateExpoConfigCache(cwd);
    log.ok(`app.json version: ${currentVersion} → ${nextVersion}`);
  }

  if (pkgJson) {
    pkgJson.version = nextVersion;
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
    log.ok(`package.json version: → ${nextVersion}`);
  }

  let nextCode: number | null = null;
  let gradle = gradleExists ? fs.readFileSync(gradlePath, 'utf8') : '';
  const freshConfig = readExpoConfig(cwd)?.config ?? appJson?.expo;
  const projectId: string | undefined =
    freshConfig?.extra?.eas?.projectId ??
    (dynamicPath ? readStaticLiteralFromDynamicConfig(dynamicPath, ['extra', 'eas', 'projectId']) : undefined);
  const gradleAppId = gradle.match(/\bapplicationId\s+['"]([^'"]+)['"]/)?.[1];
  const applicationId: string | undefined =
    freshConfig?.android?.package ??
    (dynamicPath ? readStaticLiteralFromDynamicConfig(dynamicPath, ['android', 'package']) : undefined) ??
    gradleAppId;
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
        applicationId,
        currentVersion,
        nextVersion,
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

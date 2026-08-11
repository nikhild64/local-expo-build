import fs from 'fs';
import path from 'path';
import { execaSync } from 'execa';
import { log } from '../util/log';

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
 * 1. Bump patch in app.json + package.json
 * 2. Fetch versionCode from EAS (unless skipEas), increment, write into android/app/build.gradle
 */
export function bumpVersion({
  cwd,
  profile = 'production',
  skipEas = false,
}: BumpVersionOpts): BumpVersionResult {
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
  if (!skipEas && appJson.expo?.extra?.eas?.projectId) {
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
      const result = execaSync(
        'eas',
        ['build:version:get', '--platform', 'android', '--profile', profile, '--non-interactive'],
        { cwd, encoding: 'utf8', reject: false }
      );
      const match = result.stdout.match(/Android versionCode\s*[-–]\s*(\d+)/i);
      if (result.exitCode === 0 && match) {
        nextCode = parseInt(match[1], 10) + 1;
        log.ok(`EAS versionCode: ${match[1]} → ${nextCode}`);
      } else if (result.exitCode !== 0) {
        // Never built on EAS yet — `build:version:get` fails. Seed the remote
        // version with the local versionCode first, then bump from it.
        const cur = gradle.match(/\bversionCode\s+(\d+)/);
        const localCode = cur ? parseInt(cur[1], 10) : null;
        if (localCode == null) {
          log.warn('Could not read local versionCode; falling back to local bump');
        } else {
          try {
            execaSync(
              'eas',
              [
                'build:version:set',
                '--platform',
                'android',
                '--profile',
                profile,
                '--version-code',
                String(localCode),
                '--version-name',
                currentVersion,
                '--non-interactive',
              ],
              { cwd, encoding: 'utf8' }
            );
            nextCode = localCode + 1;
            log.ok(`Seeded EAS versionCode ${localCode} (first build) → ${nextCode}`);
          } catch (err: any) {
            log.warn(`EAS version set failed. (Ensure project is linked and authenticated)`);
          }
        }
      } else {
        log.warn(`Could not parse EAS versionCode; falling back to local bump`);
      }
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

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
  if (!fs.existsSync(gradlePath))
    throw new Error(`${gradlePath} not found — run prebuild first.`);

  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const currentVersion: string = appJson.expo?.version;
  if (!currentVersion || currentVersion.split('.').length !== 3) {
    throw new Error(`Unexpected version in app.json: "${currentVersion}"`);
  }
  const parts = currentVersion.split('.');
  parts[2] = String(parseInt(parts[2], 10) + 1);
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
  if (!skipEas && appJson.expo?.extra?.eas?.projectId) {
    log.info(`Fetching EAS versionCode (profile: ${profile})...`);
    try {
      const { stdout } = execaSync(
        'eas',
        ['build:version:get', '--platform', 'android', '--profile', profile, '--non-interactive'],
        { cwd, encoding: 'utf8', reject: false }
      );
      const match = stdout.match(/Android versionCode\s*[-–]\s*(\d+)/i);
      if (match) {
        nextCode = parseInt(match[1], 10) + 1;
        log.ok(`EAS versionCode: ${match[1]} → ${nextCode}`);
      } else {
        log.warn(`Could not parse EAS versionCode; falling back to local bump`);
      }
    } catch (err: any) {
      log.warn(`EAS version fetch failed: ${err?.message || err}`);
    }
  }

  let gradle = fs.readFileSync(gradlePath, 'utf8');
  if (nextCode == null) {
    const cur = gradle.match(/\bversionCode\s+(\d+)/);
    nextCode = cur ? parseInt(cur[1], 10) + 1 : 1;
    log.dim(`Local versionCode bump: → ${nextCode}`);
  }
  gradle = gradle.replace(/(\bversionCode\s+)\d+/, `$1${nextCode}`);
  gradle = gradle.replace(/(\bversionName\s+")[^"]*"/, `$1${nextVersion}"`);
  fs.writeFileSync(gradlePath, gradle, 'utf8');
  log.ok(`build.gradle: versionCode=${nextCode}, versionName="${nextVersion}"`);

  return { versionName: nextVersion, versionCode: nextCode };
}

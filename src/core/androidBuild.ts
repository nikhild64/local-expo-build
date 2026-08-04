import fs from 'fs';
import { log as defaultLog } from '../util/log';
import { detectExpoSdk } from './sdkDetect';
import { prebuild } from './prebuild';
import { pinGradle } from './pinGradle';
import { bumpVersion } from './bumpVersion';
import { setupSigning, readKeystoreProps } from './setupSigning';
import { gradleRun } from './gradleRun';
import { syncEasVersion } from './syncEasVersion';
import { ensureKeystore } from './keystore';

export interface Logger {
  step: (msg: string) => void;
  ok: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  dim: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface AndroidBuildOpts {
  cwd: string;
  apk?: boolean;
  aab?: boolean;
  profile?: string;
  clean?: boolean;
  prebuild?: boolean;
  bump?: boolean;
  sync?: boolean;
  dryRun?: boolean;
  logger?: Logger;
  onLine?: (line: string) => void;
  ensureKeystoreMode?: 'interactive' | 'required-existing';
}

export interface AndroidBuildResult {
  artifact: string;
  kind: 'APK' | 'AAB';
}

export async function runAndroidBuild(opts: AndroidBuildOpts): Promise<AndroidBuildResult> {
  const logger: Logger = opts.logger || defaultLog;
  const task: 'assembleRelease' | 'bundleRelease' = opts.apk ? 'assembleRelease' : 'bundleRelease';
  const kind = task === 'bundleRelease' ? 'AAB' : 'APK';
  const profile = opts.profile || 'production';
  const dryRun = !!opts.dryRun;
  const ensureMode = opts.ensureKeystoreMode || 'interactive';

  logger.step(`local-expo-build android (${kind})`);
  logger.dim('Local build · runs on your machine · saves an EAS cloud build credit');
  logger.dim(`cwd: ${opts.cwd}`);
  if (dryRun) {
    logger.warn('DRY RUN — no files modified, no Gradle build executed.');
  }

  const sdk = detectExpoSdk(opts.cwd);
  logger.ok(`Detected Expo SDK ${sdk.major} (${sdk.raw})`);

  // 1/6 prebuild
  if (opts.prebuild !== false) {
    logger.step('1/6 expo prebuild');
    if (dryRun) {
      logger.dim(`[dry-run] would run: expo prebuild --platform android${opts.clean ? ' --clean' : ''}`);
    } else {
      await prebuild({ cwd: opts.cwd, clean: opts.clean, onLine: opts.onLine });
    }
  } else {
    logger.dim('Skipping prebuild (--no-prebuild)');
  }

  // 2/6 pin Gradle wrapper
  logger.step('2/6 pin Gradle wrapper');
  if (dryRun) {
    logger.dim(`[dry-run] would pin Gradle wrapper for SDK ${sdk.major} (see src/core/pinGradle.ts)`);
  } else {
    await pinGradle({ cwd: opts.cwd, sdk: sdk.major });
  }

  // 3/6 bump version
  if (opts.bump !== false) {
    logger.step('3/6 bump version');
    if (dryRun) {
      logger.dim(`[dry-run] would fetch next versionCode from EAS (profile=${profile}) and write app.json + build.gradle`);
    } else {
      bumpVersion({ cwd: opts.cwd, profile });
    }
  } else {
    logger.dim('Skipping version bump (--no-bump)');
  }

  // 4/6 ensure keystore + inject signing config
  logger.step('4/6 ensure keystore + inject signing config');
  if (dryRun) {
    logger.dim('[dry-run] would ensure keystore.properties + .jks present, then inject release signingConfig into build.gradle');
  } else {
    if (ensureMode === 'required-existing') {
      const props = readKeystoreProps(opts.cwd);
      if (!props) {
        throw new Error(
          'Signing keystore not configured (keystore.properties missing or incomplete). Please set up your keystore in the Keystore tab before building.'
        );
      }
    } else {
      await ensureKeystore(opts.cwd);
    }
    setupSigning({ cwd: opts.cwd });
  }

  // 5/6 gradle run
  logger.step(`5/6 gradle ${task}`);
  let artifact = '';
  if (dryRun) {
    const isWin = process.platform === 'win32';
    const wrapper = isWin ? 'gradlew.bat' : './gradlew';
    logger.dim(`[dry-run] would run (cwd=android/): ${wrapper} ${task}`);
  } else {
    artifact = await gradleRun({ cwd: opts.cwd, task, onLine: opts.onLine });
  }

  // 6/6 sync EAS versionCode
  if (opts.sync !== false) {
    logger.step('6/6 sync EAS versionCode');
    if (dryRun) {
      logger.dim('[dry-run] would POST new versionCode to api.expo.dev/graphql (non-fatal on failure)');
    } else {
      try {
        await syncEasVersion({ cwd: opts.cwd });
      } catch (err: any) {
        logger.warn(`EAS sync failed (non-fatal): ${err?.message || err}`);
      }
    }
  } else {
    logger.dim('Skipping EAS sync (--no-sync)');
  }

  logger.step('Done');
  if (dryRun) {
    logger.ok(`DRY RUN complete — 6 steps shown for ${kind}. Re-run without --dry-run to actually build.`);
  } else if (fs.existsSync(artifact)) {
    const sizeMb = (fs.statSync(artifact).size / 1024 / 1024).toFixed(2);
    logger.ok(`Build complete (${kind}, ${sizeMb} MB):\n  ${artifact}`);
  } else {
    logger.warn(`Build finished but artifact not found at ${artifact}`);
  }

  return { artifact, kind };
}

import fs from 'fs';
import { Command } from 'commander';
import { getCtx } from '../util/ctx';
import { log } from '../util/log';
import { detectExpoSdk } from '../core/sdkDetect';
import { prebuild } from '../core/prebuild';
import { pinGradle } from '../core/pinGradle';
import { bumpVersion } from '../core/bumpVersion';
import { setupSigning } from '../core/setupSigning';
import { gradleRun } from '../core/gradleRun';
import { syncEasVersion } from '../core/syncEasVersion';
import { ensureKeystore } from '../core/keystore';

export function registerBuildCommand(program: Command): void {
  const build = program.command('build').description('Build commands');

  build
    .command('android')
    .description('Build a local Android APK or AAB')
    .option('--apk', 'build APK (assembleRelease)')
    .option('--aab', 'build AAB (bundleRelease) — default')
    .option('--profile <profile>', 'EAS profile for versionCode fetch', 'production')
    .option('--clean', 'pass --clean to expo prebuild')
    .option('--no-bump', 'skip version bump')
    .option('--no-sync', 'skip EAS versionCode sync after build')
    .option('--no-prebuild', 'skip expo prebuild step')
    .action(async (opts, cmd) => {
      const ctx = getCtx(cmd);
      const task: 'assembleRelease' | 'bundleRelease' = opts.apk ? 'assembleRelease' : 'bundleRelease';
      const kind = task === 'bundleRelease' ? 'AAB' : 'APK';

      log.step(`expo-local-build android (${kind})`);
      log.dim('Local build · runs on your machine · saves an EAS cloud build credit');
      log.dim(`cwd: ${ctx.cwd}`);
      if (ctx.dryRun) {
        log.warn('DRY RUN — no files modified, no Gradle build executed.');
      }

      const sdk = detectExpoSdk(ctx.cwd);
      log.ok(`Detected Expo SDK ${sdk.major} (${sdk.raw})`);

      if (opts.prebuild !== false) {
        log.step('1/6 expo prebuild');
        if (ctx.dryRun) {
          log.dim(`[dry-run] would run: expo prebuild --platform android${opts.clean ? ' --clean' : ''}`);
        } else {
          await prebuild({ cwd: ctx.cwd, clean: Boolean(opts.clean) });
        }
      } else {
        log.dim('Skipping prebuild (--no-prebuild)');
      }

      log.step('2/6 pin Gradle wrapper');
      if (ctx.dryRun) {
        log.dim(`[dry-run] would pin Gradle wrapper for SDK ${sdk.major} (see src/core/pinGradle.ts)`);
      } else {
        pinGradle({ cwd: ctx.cwd, sdk: sdk.major });
      }

      if (opts.bump !== false) {
        log.step('3/6 bump version');
        if (ctx.dryRun) {
          log.dim(`[dry-run] would fetch next versionCode from EAS (profile=${opts.profile}) and write app.json + build.gradle`);
        } else {
          bumpVersion({ cwd: ctx.cwd, profile: opts.profile });
        }
      } else {
        log.dim('Skipping version bump (--no-bump)');
      }

      log.step('4/6 ensure keystore + inject signing config');
      if (ctx.dryRun) {
        log.dim('[dry-run] would ensure keystore.properties + .jks present, then inject release signingConfig into build.gradle');
      } else {
        await ensureKeystore(ctx.cwd);
        setupSigning({ cwd: ctx.cwd });
      }

      log.step(`5/6 gradle ${task}`);
      let artifact = '';
      if (ctx.dryRun) {
        const isWin = process.platform === 'win32';
        const wrapper = isWin ? 'gradlew.bat' : './gradlew';
        log.dim(`[dry-run] would run (cwd=android/): ${wrapper} ${task}`);
      } else {
        artifact = await gradleRun({ cwd: ctx.cwd, task });
      }

      if (opts.sync !== false) {
        log.step('6/6 sync EAS versionCode');
        if (ctx.dryRun) {
          log.dim('[dry-run] would POST new versionCode to api.expo.dev/graphql (non-fatal on failure)');
        } else {
          try {
            await syncEasVersion({ cwd: ctx.cwd });
          } catch (err: any) {
            log.warn(`EAS sync failed (non-fatal): ${err?.message || err}`);
          }
        }
      } else {
        log.dim('Skipping EAS sync (--no-sync)');
      }

      log.step('Done');
      if (ctx.dryRun) {
        log.ok(`DRY RUN complete — 6 steps shown for ${kind}. Re-run without --dry-run to actually build.`);
      } else if (fs.existsSync(artifact)) {
        const sizeMb = (fs.statSync(artifact).size / 1024 / 1024).toFixed(2);
        log.ok(`Build complete (${kind}, ${sizeMb} MB):\n  ${artifact}`);
      } else {
        log.warn(`Build finished but artifact not found at ${artifact}`);
      }
    });
}

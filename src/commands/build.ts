import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { getCtx } from '../util/ctx';
import { log } from '../util/log';
import { runAndroidBuild } from '../core/androidBuild';
import { bumpVersion } from '../core/bumpVersion';
import { detectExpoSdk } from '../core/sdkDetect';
import { assertMacOS, printIosExperimentalBanner } from '../util/platform';
import { projectBinExecArgs, resolveProjectBin } from '../util/resolveProjectBin';
import { maybePromptScriptUpdate } from '../util/maybePromptScriptUpdate';
import { detectIosProject } from '../core/ios/detect';
import { readIosCredentials } from '../core/ios/credentials';
import {
  IosExportMethod,
  writeExportOptionsPlist,
} from '../core/ios/exportOptions';
import { xcodebuildArchive, xcodebuildExport } from '../core/ios/xcodebuild';

/**
 * Resolves whether to pass `--clean` to `expo prebuild`. Tri-state:
 *   - `--clean` flag → true (skip prompt)
 *   - `--no-clean` flag → false (skip prompt)
 *   - neither, interactive TTY, not dry-run → interactive prompt (default: false)
 *   - neither, non-TTY or dry-run → false (safe default for CI / previews)
 *
 * `opts.clean` is commander's representation: `true` for `--clean`, `false`
 * for `--no-clean`, `undefined` when neither is passed.
 */
async function resolveCleanFlag(
  opts: { clean?: boolean },
  ctx: { dryRun: boolean }
): Promise<boolean> {
  if (opts.clean === true) return true;
  if (opts.clean === false) return false;
  if (!process.stdin.isTTY || ctx.dryRun) return false;
  return await confirm({
    message:
      'Clean android/ before prebuild? (slower, but required after Expo SDK upgrade, ' +
      'plugin change, or "android project is malformed" / "MainActivity not found" errors)',
    default: false,
  });
}

export function registerBuildCommand(program: Command): void {
  const build = program.command('build').description('Build commands');

  build
    .command('android')
    .description('Build a local Android APK or AAB')
    .option('--apk', 'build APK (assembleRelease)')
    .option('--aab', 'build AAB (bundleRelease) — default')
    .option('--profile <profile>', 'EAS profile for versionCode fetch', 'production')
    .option('--clean', 'force `expo prebuild --clean` (skip the prompt)')
    .option('--no-clean', 'force skip `--clean` (skip the prompt; also the default in CI / non-TTY)')
    .option('--no-bump', 'skip version bump')
    .option('--no-sync', 'skip EAS versionCode sync after build')
    .option('--no-prebuild', 'skip expo prebuild step')
    .action(async (opts, cmd) => {
      const ctx = getCtx(cmd);
      await maybePromptScriptUpdate({
        cwd: ctx.cwd,
        dryRun: ctx.dryRun,
        skip: ctx.skipUpdateCheck,
      });

      const shouldClean = await resolveCleanFlag(opts, ctx);
      await runAndroidBuild({
        cwd: ctx.cwd,
        apk: opts.apk,
        aab: opts.aab,
        profile: opts.profile,
        clean: shouldClean,
        prebuild: opts.prebuild,
        bump: opts.bump,
        sync: opts.sync,
        dryRun: ctx.dryRun,
        ensureKeystoreMode: 'interactive',
      });
    });

  // ────────────────────────────────────────────────────────────────────────
  // build ios — experimental
  // ────────────────────────────────────────────────────────────────────────
  build
    .command('ios')
    .description('Build a local iOS .ipa via xcodebuild (EXPERIMENTAL · macOS only)')
    .option(
      '--method <method>',
      'distribution method: app-store | ad-hoc | development | enterprise',
      'app-store'
    )
    .option('--scheme <scheme>', 'Xcode scheme to build (auto-detected if omitted)')
    .option('--configuration <config>', 'Xcode configuration', 'Release')
    .option('--team-id <id>', '10-character Apple team identifier (required for manual signing)')
    .option('--profile-name <name>', 'provisioning profile name (as listed in the .mobileprovision)')
    .option('--bundle-id <id>', 'app bundle identifier (read from app.json if omitted)')
    .option('--clean', 'force `expo prebuild --clean` (skip the prompt)')
    .option('--no-clean', 'force skip `--clean` (skip the prompt; also the default in CI / non-TTY)')
    .option('--no-bump', 'skip version bump')
    .option('--no-prebuild', 'skip expo prebuild step')
    .action(async (opts, cmd) => {
      const ctx = getCtx(cmd);
      log.step('local-expo-build ios (.ipa)');
      log.dim('Local iOS build · macOS only · saves an EAS cloud build credit');
      printIosExperimentalBanner();
      log.dim(`cwd: ${ctx.cwd}`);

      if (!ctx.dryRun) assertMacOS('build ios');

      await maybePromptScriptUpdate({
        cwd: ctx.cwd,
        dryRun: ctx.dryRun,
        skip: ctx.skipUpdateCheck,
      });

      const method = String(opts.method) as IosExportMethod;
      if (!['app-store', 'ad-hoc', 'development', 'enterprise'].includes(method)) {
        throw new Error(
          `Invalid --method "${method}". Use one of: app-store, ad-hoc, development, enterprise.`
        );
      }

      const sdk = detectExpoSdk(ctx.cwd);
      log.ok(`Detected Expo SDK ${sdk.major} (${sdk.raw})`);

      // ── 1/5 prebuild ──
      const shouldCleanIos = await resolveCleanFlag(opts, ctx);
      if (opts.prebuild !== false) {
        log.step('1/5 expo prebuild (ios)');
        if (ctx.dryRun) {
          log.dim(
            `[dry-run] would run: expo prebuild --platform ios${shouldCleanIos ? ' --clean' : ''}`
          );
        } else {
          const bin = resolveProjectBin('expo', ctx.cwd);
          if (!bin) {
            throw new Error(
              'expo CLI not found — install dependencies in your project (`npm install`, `bun install`, etc.)'
            );
          }
          const { command, args, execa: execaOpts } = projectBinExecArgs(bin, [
            'prebuild',
            '--platform',
            'ios',
            '--non-interactive',
            ...(shouldCleanIos ? ['--clean'] : []),
          ]);
          await execa(command, args, { cwd: ctx.cwd, stdio: 'inherit', ...execaOpts });
        }
      } else {
        log.dim('Skipping prebuild (--no-prebuild)');
      }

      // ── 2/5 bump version (reuses the Android-tested bumpVersion; touches app.json + iOS Info.plist via Expo) ──
      if (opts.bump !== false) {
        log.step('2/5 bump version');
        if (ctx.dryRun) {
          log.dim('[dry-run] would bump expo.version + pull next iOS buildNumber from EAS');
        } else {
          // Note: bumpVersion is currently Android-focused (writes
          // android/app/build.gradle versionCode). For iOS, the buildNumber
          // lives in Info.plist (CFBundleVersion) and is updated by Expo's
          // prebuild from app.json. We only bump app.json here.
          bumpVersion({ cwd: ctx.cwd, profile: 'production' });
        }
      } else {
        log.dim('Skipping version bump (--no-bump)');
      }

      // ── 3/5 detect xcode project + read credentials ──
      log.step('3/5 detect Xcode workspace + credentials');
      const project = detectIosProject(ctx.cwd);
      if (!project && !ctx.dryRun) {
        throw new Error(
          `Could not find a single .xcworkspace in ${path.join(ctx.cwd, 'ios')}. ` +
            `Either prebuild hasn't run yet (drop --no-prebuild) or your project has ` +
            `multiple workspaces (pass --scheme to disambiguate, and file an issue so we can handle multi-workspace projects).`
        );
      }
      const scheme = opts.scheme || project?.inferredScheme || '(unknown)';
      log.dim(`workspace: ${project ? path.relative(ctx.cwd, project.workspacePath) : '(dry-run)'}`);
      log.dim(`scheme: ${scheme}`);

      const creds = readIosCredentials(ctx.cwd);
      if (!creds) {
        log.warn(
          'No usable `ios` section in credentials.json — xcodebuild will rely on ' +
            'Xcode automatic signing (your Apple ID must be logged in). For ' +
            'reproducible signed builds, run `eas credentials --platform ios` and ' +
            'choose "Download credentials from EAS to credentials.json".'
        );
      } else {
        log.dim(`distribution cert: ${creds.distributionCertificatePath}`);
        log.dim(`provisioning profile: ${creds.provisioningProfilePath}`);
        log.dim(
          'NOTE: ensure the .p12 is imported into your login keychain and the ' +
            'provisioning profile is installed at ~/Library/MobileDevice/Provisioning Profiles/ ' +
            '(Xcode does this automatically when you double-click the file).'
        );
      }

      // ── 4/5 archive ──
      log.step(`4/5 xcodebuild archive (${opts.configuration})`);
      const archivePath = path.join(ctx.cwd, 'ios', 'build', `${scheme}.xcarchive`);
      if (ctx.dryRun) {
        log.dim(`[dry-run] would archive to ${path.relative(ctx.cwd, archivePath)}`);
      } else {
        await xcodebuildArchive({
          cwd: ctx.cwd,
          workspacePath: project!.workspacePath,
          scheme,
          configuration: String(opts.configuration),
          archivePath,
        });
      }

      // ── 5/5 export ipa ──
      log.step(`5/5 xcodebuild -exportArchive (method=${method})`);
      const exportDir = path.join(ctx.cwd, 'ios', 'build', 'export');
      let ipaPath = '';
      if (ctx.dryRun) {
        log.dim(`[dry-run] would write export-options.plist (method=${method})`);
        log.dim(`[dry-run] would export .ipa to ${path.relative(ctx.cwd, exportDir)}`);
      } else {
        const plistPath = writeExportOptionsPlist(ctx.cwd, {
          method,
          teamId: opts.teamId,
          bundleIdentifier: opts.bundleId,
          provisioningProfileName: opts.profileName,
        });
        ipaPath = await xcodebuildExport({
          cwd: ctx.cwd,
          archivePath,
          exportPath: exportDir,
          exportOptionsPlistPath: plistPath,
        });
      }

      log.step('Done');
      if (ctx.dryRun) {
        log.ok(`DRY RUN complete — 5 steps shown for iOS (.ipa). Re-run without --dry-run on a Mac to build.`);
      } else if (ipaPath && fs.existsSync(ipaPath)) {
        const sizeMb = (fs.statSync(ipaPath).size / 1024 / 1024).toFixed(2);
        log.ok(`Build complete (.ipa, ${sizeMb} MB):\n  ${ipaPath}`);
      } else {
        log.warn(`Build finished but .ipa not found in ${exportDir}`);
      }
    });
}

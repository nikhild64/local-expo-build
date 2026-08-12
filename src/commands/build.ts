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
import { androidPackageCheck, setAndroidPackage } from './doctor';
import { readKeystoreProps } from '../core/setupSigning';
import { autoSetupKeystore } from '../core/keystore/autoSetup';
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

/**
 * The two file-based prerequisites checked before an Android build: the
 * package name (`expo.android.package`) and the release signing keystore.
 */
export interface AndroidPreflightAnalysis {
  needsPackage: boolean;
  needsKeystore: boolean;
  /** Human-readable "missing" list for the confirm prompt, e.g. "the Android
   * package (expo.android.package) and a release signing keystore". */
  missing: string;
}

/**
 * Injectable fix implementations for {@link applyAndroidPreflightFixes} —
 * tests stub the keystore setup without touching the real provider chain.
 */
export interface AndroidPreflightFixers {
  setAndroidPackage?: (cwd: string, packageName: string) => void;
  /** Defaults to the shared auto-setup chain (rehydrate → EAS fetch → generate). */
  setupKeystore?: (cwd: string) => Promise<unknown>;
}

/**
 * File-only analysis of the prerequisites for an Android build — no env
 * probing (JDK, ANDROID_HOME) and no TTY required. Reads `app.json` (or the
 * dynamic config, if present) for the package and `keystore.properties` for
 * the release keystore. Debug builds skip the keystore check (they use the
 * debug key).
 */
export function analyzeAndroidPreflight(
  cwd: string,
  opts: { debug: boolean }
): AndroidPreflightAnalysis {
  const pkg = androidPackageCheck(cwd);
  const needsPackage = pkg.source === 'app.json' && !pkg.pkg;
  const needsKeystore = !opts.debug && !readKeystoreProps(cwd);
  const missing = [
    needsPackage ? 'the Android package (expo.android.package)' : null,
    needsKeystore ? 'a release signing keystore' : null,
  ]
    .filter(Boolean)
    .join(' and ');
  return { needsPackage, needsKeystore, missing };
}

/**
 * Applies the fixes for the missing prerequisites, logging the outcome. Each
 * fix is wrapped so one failing fix doesn't stop the other. `fixers` defaults
 * to the real implementations (doctor's `setAndroidPackage` and the keystore
 * provider chain); tests inject stubs.
 */
export async function applyAndroidPreflightFixes(
  cwd: string,
  analysis: Pick<AndroidPreflightAnalysis, 'needsPackage' | 'needsKeystore'>,
  fixers: AndroidPreflightFixers = {}
): Promise<void> {
  const { setAndroidPackage: setPkg = setAndroidPackage, setupKeystore: setupKs = autoSetupKeystore } = fixers;

  if (analysis.needsPackage) {
    const folder = path.basename(cwd).toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';
    const pkgName = `com.example.${folder}`;
    try {
      setPkg(cwd, pkgName);
      log.ok(`Set expo.android.package = "${pkgName}" in app.json`);
    } catch (err: any) {
      log.error(`Could not set Android package: ${err?.message || err}`);
    }
  }

  if (analysis.needsKeystore) {
    try {
      await setupKs(cwd);
      log.ok('Signing keystore configured.');
    } catch (err: any) {
      log.error(`Keystore setup failed: ${err?.message || err}`);
    }
  }
}

/**
 * Fast pre-flight for `build android` (P0-2): checks the two file-based
 * prerequisites that would otherwise fail the pipeline late — the Android
 * package (`expo.android.package`) and the release signing keystore. In an
 * interactive terminal it offers to fix both with a single confirm before the
 * pipeline starts; non-TTY and `--dry-run` leave the existing behavior
 * untouched (the pipeline surfaces the problem with its normal error).
 *
 * `deps` lets tests drive the confirm prompt and stub the fixes without a TTY.
 */
export async function preflightAndroidBuild(
  cwd: string,
  opts: { dryRun: boolean; debug: boolean },
  deps: { confirm?: (message: string) => Promise<boolean>; fixers?: AndroidPreflightFixers } = {}
): Promise<void> {
  if (opts.dryRun || !process.stdin.isTTY) return;

  const analysis = analyzeAndroidPreflight(cwd, { debug: opts.debug });
  if (!analysis.needsPackage && !analysis.needsKeystore) return;

  const ask = deps.confirm || (async (message: string) =>
    confirm({ message, default: true }));
  const shouldFix = await ask(
    `This project is missing ${analysis.missing}. Set it up automatically before building?`
  );
  console.log('');
  if (!shouldFix) {
    log.dim('Proceeding without setup — the build may fail. Run `local-expo-build doctor` to inspect.');
    return;
  }

  await applyAndroidPreflightFixes(cwd, analysis, deps.fixers);
}

/** Options accepted by {@link runBuildAndroid} (commander flags for `build android`). */
export interface BuildAndroidCliOpts {
  apk?: boolean;
  aab?: boolean;
  profile?: string;
  clean?: boolean;
  prebuild?: boolean;
  bump?: boolean;
  sync?: boolean;
  debug?: boolean;
  maxRam?: string;
}

/**
 * The full `build android` flow, shared by the `build android` command and
 * the init wizard's "run a build now?" follow-up (init picks AAB vs APK via a
 * list and hands the chosen flags here). cwd/dryRun come from the commander
 * globals, so the same context works from either entry point.
 */
export async function runBuildAndroid(opts: BuildAndroidCliOpts, cmd: Command): Promise<void> {
  const ctx = getCtx(cmd);
  await maybePromptScriptUpdate({
    cwd: ctx.cwd,
    dryRun: ctx.dryRun,
    skip: ctx.skipUpdateCheck,
  });

  await preflightAndroidBuild(ctx.cwd, { dryRun: ctx.dryRun, debug: !!opts.debug });

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
    debug: !!opts.debug,
    maxRam: opts.maxRam,
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
    .option('--debug', 'build a debug APK with the debug keystore (no EAS, no version bump, no signing setup)')
    .option('--max-ram <ram>', 'Max RAM allocation for Gradle & Node (e.g. 2g, 4g, 8g, 12g, 16g)', 'default')
    .action(async (opts, cmd) => {
      await runBuildAndroid(opts, cmd);
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
          // CI=1 replaces --non-interactive (removed in expo CLI for SDK 54+).
          const { command, args, execa: execaOpts } = projectBinExecArgs(bin, [
            'prebuild',
            '--platform',
            'ios',
            ...(shouldCleanIos ? ['--clean'] : []),
          ]);
          await execa(command, args, {
            cwd: ctx.cwd,
            stdio: 'inherit',
            env: { ...process.env, CI: '1' },
            ...execaOpts,
          });
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
          await bumpVersion({ cwd: ctx.cwd, profile: 'production' });
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
            `Either prebuild hasn't run yet (drop --no-prebuild), or ios/ contains zero or ` +
            `multiple workspaces. Expo's prebuild generates exactly one workspace named after ` +
            `your app; if you see several (e.g. after a rename), delete the stale ones and ` +
            `re-run prebuild. --scheme only selects the scheme inside an existing single ` +
            `workspace, so it cannot disambiguate multiple workspaces.`
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

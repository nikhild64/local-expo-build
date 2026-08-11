import fs from 'fs';
import path from 'path';
import kleur from 'kleur';
import { Command } from 'commander';
import { confirm, select } from '@inquirer/prompts';
import { getCtx } from '../util/ctx';
import { log } from '../util/log';
import { detectExpoSdk } from '../core/sdkDetect';
import { GRADLE_PIN } from '../core/pinGradle';
import { ensureKeystore } from '../core/keystore';
import { ensureGitignoreEntries } from '../util/gitignore';
import { detectPackageManager, formatCliCommand, formatRunScript } from '../util/resolveProjectBin';
import { TEMPLATE_SCRIPTS } from '../core/scaffoldScripts';
import { readKeystoreProps } from '../core/setupSigning';
import { runDoctor } from './doctor';
import { runBuildAndroid, BuildAndroidCliOpts } from './build';
import { findUnconfiguredKeystoreFile } from '../core/keystore/autoSetup';

const APK_CHAIN = 'node scripts/build.js apk';
const AAB_CHAIN = 'node scripts/build.js aab';

function templatesDir(): string {
  // dist/commands -> ../../templates
  return path.resolve(__dirname, '..', '..', 'templates');
}

export interface InitCommandOpts {
  force?: boolean;
  keystore?: boolean;
  doctor?: boolean;
  /** `--no-build` skips the "run a build now?" follow-up prompt. */
  build?: boolean;
}

/** Injectable pieces for the "run a build now?" follow-up — tests stub them
 * so the prompts and the build can be driven without a TTY. */
export interface BuildNowDeps {
  confirm?: (message: string) => Promise<boolean>;
  select?: (opts: { message: string; choices: { name: string; value: string }[] }) => Promise<string>;
  runBuild?: (opts: BuildAndroidCliOpts, cmd: Command) => Promise<void>;
}

/**
 * After `init` completes, offers to jump straight into a build: one confirm,
 * then a list of AAB / APK. Only reached from `runInit` when stdin is a TTY
 * and `--no-build` was not passed; non-interactive shells get the plain
 * "Next steps" hints instead.
 */
export async function maybePromptBuildNow(cmd: Command, deps: BuildNowDeps = {}): Promise<void> {
  // Enter proceeds — same as the other "continue?" prompts in the wizard
  // (fix-all, keystore setup), so a bare return doesn't skip the build.
  const ask = deps.confirm || ((message: string) => confirm({ message, default: true }));
  const choose = deps.select || ((opts) => select(opts));
  const run = deps.runBuild || runBuildAndroid;

  const go = await ask('Run a build now?');
  if (!go) return;

  const format = await choose({
    message: 'Which artifact do you want to build?',
    choices: [
      { name: 'AAB (bundleRelease) — upload to the Play Store', value: 'aab' },
      { name: 'APK (assembleRelease) — sideload / direct install', value: 'apk' },
    ],
  });
  console.log('');

  await run(
    {
      apk: format === 'apk',
      aab: format === 'aab',
      profile: 'production',
      prebuild: true,
      bump: true,
      sync: true,
      maxRam: 'default',
    },
    cmd
  );
}

/**
 * Runs the full `init` flow: optional doctor pre-flight, then scaffolds the
 * build scripts, package.json entries, and gitignore rules, then the optional
 * keystore setup. Shared by the `init` command and the bare-invocation
 * default (`runDefaultCommand`).
 */
export async function runInit(opts: InitCommandOpts, cmd: Command, deps: BuildNowDeps = {}): Promise<void> {
  const { cwd, dryRun } = getCtx(cmd);
  const cliCmd = formatCliCommand(detectPackageManager(cwd));
  log.step('local-expo-build init');
  log.dim('One-time setup for local Expo Android builds · you keep full signing control');
  log.dim(`Target: ${cwd}`);

  // Pre-flight: run `doctor` so the environment is verified (and any missing
  // pieces auto-fixed) before we scaffold anything into the project.
  if (opts.doctor !== false) {
    const { failedCount } = await runDoctor({
      cwd,
      dryRun,
      title: 'local-expo-build init › pre-flight checks',
    });
    if (failedCount > 0) {
      if (!process.stdin.isTTY) {
        throw new Error(
          `${failedCount} check(s) still failing and no interactive terminal to confirm — aborting. ` +
            `Fix the issues above and re-run, or pass --no-doctor to skip the pre-flight.`
        );
      }
      const proceed = await confirm({
        message: `${failedCount} check(s) still failing. Continue with init anyway?`,
        default: false,
      });
      if (!proceed) {
        log.dim('Aborted. Fix the issues above and re-run, or pass --no-doctor to skip.');
        return;
      }
    }
    console.log('');
  }

  const sdk = detectExpoSdk(cwd);
  log.ok(`Detected Expo SDK ${sdk.major} (${sdk.raw})`);
  if (!(sdk.major in GRADLE_PIN)) {
    log.warn(
      `SDK ${sdk.major} is not in the supported table. pin-gradle will be a no-op. ` +
        `If you hit a Gradle plugin error, update GRADLE_PIN.`
    );
  }

  const tplDir = templatesDir();
  const scriptsDir = path.join(cwd, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  for (const file of TEMPLATE_SCRIPTS) {
    const src = path.join(tplDir, 'scripts', file);
    const dest = path.join(scriptsDir, file);
    if (fs.existsSync(dest) && !opts.force) {
      log.warn(`Exists, skipped (use --force): ${path.relative(cwd, dest)}`);
      continue;
    }
    fs.copyFileSync(src, dest);
    log.ok(`Wrote ${path.relative(cwd, dest)}`);
  }

  const examplePath = path.join(cwd, 'keystore.properties.example');
  if (!fs.existsSync(examplePath)) {
    fs.copyFileSync(path.join(tplDir, 'keystore.properties.example'), examplePath);
    log.ok('Wrote keystore.properties.example');
  }

  const pkgPath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.scripts = pkg.scripts || {};
  let modified = false;
  for (const [name, value] of [
    ['build:android:apk', APK_CHAIN],
    ['build:android:aab', AAB_CHAIN],
  ] as const) {
    if (pkg.scripts[name] && pkg.scripts[name] !== value && !opts.force) {
      log.warn(`Script "${name}" already exists; not overwriting. Use --force to replace.`);
      continue;
    }
    pkg.scripts[name] = value;
    modified = true;
    log.ok(`package.json: ${name}`);
  }
  if (modified) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  ensureGitignoreEntries(cwd, ['keystore.properties', '*.jks', '*.p12', 'credentials.json']);

  if (opts.keystore !== false) {
    if (readKeystoreProps(cwd)) {
      // Doctor's pre-flight (or a previous run) already configured the
      // keystore — don't ask again (ensureKeystore would no-op anyway).
      log.dim('Keystore already configured — skipping keystore setup.');
    } else if (process.stdin.isTTY) {
      // A keystore file without properties has an unknown password — say so
      // instead of asking to "set up" a new one and failing on the collision.
      const unconfigured = findUnconfiguredKeystoreFile(cwd);
      if (unconfigured) {
        log.warn(
          `Found ${unconfigured} but no keystore.properties — its password is unknown. ` +
            `Import it with its password, or delete it to generate a fresh keystore.`
        );
      }
      const wantsKs = await confirm({
        message: unconfigured
          ? 'Configure the signing keystore now (bind the existing file or replace it)?'
          : 'Set up the Android signing keystore now?',
        default: true,
      });
      if (wantsKs) {
        await ensureKeystore(cwd);
      } else {
        log.dim(`Skipping keystore setup. Run later: ${cliCmd} keystore setup`);
      }
    } else {
      log.dim(`Non-interactive shell — skipping keystore setup. Run later: ${cliCmd} keystore setup`);
    }
  }

  log.step('Init complete');
  log.info('Next steps:');
  const pm = detectPackageManager(cwd);
  log.dim(`  ${formatRunScript(pm, 'build:android:aab')}    # build a release AAB`);
  log.dim(`  ${formatRunScript(pm, 'build:android:apk')}    # build a release APK`);
  log.dim(`  ${cliCmd} doctor  # re-run env checks any time`);

  // Interactive shells only: offer to jump straight into a build, asking
  // AAB vs APK as a list. Skipped under `--no-build` and in CI / non-TTY.
  if (opts.build !== false && process.stdin.isTTY) {
    await maybePromptBuildNow(cmd, deps);
  }
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold local-build scripts + package.json entries into an Expo project')
    .option('--force', 'overwrite existing scripts/*.js files')
    .option('--no-keystore', 'skip interactive keystore setup')
    .option('--no-doctor', 'skip the pre-flight `doctor` run')
    .option('--no-build', 'skip the "run a build now?" prompt after setup')
    .action(async (opts, cmd) => {
      await runInit(opts, cmd);
    });
}

/**
 * True when the directory looks like an Expo project (package.json declares
 * `expo` as a dependency). Used to decide whether a bare `local-expo-build`
 * invocation should auto-start the `init` wizard.
 */
export function isExpoProject(cwd: string): boolean {
  try {
    detectExpoSdk(cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * The default behavior for a bare `local-expo-build` invocation (no
 * subcommand). Inside an Expo project this runs the `init` setup wizard so a
 * bare call does something useful; anywhere else it prints a short hint
 * instead of scaffolding into the wrong directory.
 */
export async function runDefaultCommand(cmd: Command): Promise<void> {
  const { cwd } = getCtx(cmd);
  if (isExpoProject(cwd)) {
    console.log(kleur.dim('No command given — running the setup wizard (`init`).'));
    await runInit({}, cmd);
    return;
  }
  console.log(kleur.yellow('No command given and this does not look like an Expo project.'));
  console.log(kleur.dim('  cd into your Expo project, then run:'));
  console.log(kleur.dim('    local-expo-build init      scaffold build scripts + one-time setup'));
  console.log(kleur.dim('    local-expo-build ui        open the browser UI'));
  console.log(kleur.dim('    local-expo-build doctor    check your environment'));
}

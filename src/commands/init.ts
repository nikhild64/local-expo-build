import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { getCtx } from '../util/ctx';
import { log } from '../util/log';
import { detectExpoSdk } from '../core/sdkDetect';
import { GRADLE_PIN } from '../core/pinGradle';
import { ensureKeystore } from '../core/keystore';
import { ensureGitignoreEntries } from '../util/gitignore';
import { detectPackageManager, formatRunScript } from '../util/resolveProjectBin';
import { TEMPLATE_SCRIPTS } from '../core/scaffoldScripts';
import { runDoctor } from './doctor';

const APK_CHAIN = 'node scripts/build.js apk';
const AAB_CHAIN = 'node scripts/build.js aab';

function templatesDir(): string {
  // dist/commands -> ../../templates
  return path.resolve(__dirname, '..', '..', 'templates');
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold local-build scripts + package.json entries into an Expo project')
    .option('--force', 'overwrite existing scripts/*.js files')
    .option('--no-keystore', 'skip interactive keystore setup')
    .option('--no-doctor', 'skip the pre-flight `doctor` run')
    .action(async (opts, cmd) => {
      const { cwd, dryRun } = getCtx(cmd);
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

      ensureGitignoreEntries(cwd, ['keystore.properties', '*.jks', 'credentials.json']);

      if (opts.keystore !== false) {
        const wantsKs = await confirm({
          message: 'Set up the Android signing keystore now?',
          default: true,
        });
        if (wantsKs) {
          await ensureKeystore(cwd);
        } else {
          log.dim('Skipping keystore setup. Run later: npx local-expo-build keystore setup');
        }
      }

      log.step('Init complete');
      log.info('Next steps:');
      const pm = detectPackageManager(cwd);
      log.dim(`  ${formatRunScript(pm, 'build:android:aab')}    # build a release AAB`);
      log.dim(`  ${formatRunScript(pm, 'build:android:apk')}    # build a release APK`);
      log.dim('  npx local-expo-build doctor  # re-run env checks any time');
    });
}

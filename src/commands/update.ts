import path from 'path';
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import kleur from 'kleur';
import { getCtx } from '../util/ctx';
import { log } from '../util/log';
import {
  applyScriptUpdates,
  compareScripts,
  TEMPLATE_SCRIPTS,
} from '../core/scaffoldScripts';

export function registerUpdateCommand(program: Command): void {
  program
    .command('update-scripts')
    .description('Refresh scaffolded scripts/*.js to the version bundled with this CLI')
    .option('-y, --yes', 'apply all updates without prompting')
    .action(async (opts, cmd) => {
      const { cwd, dryRun } = getCtx(cmd);
      log.step('local-expo-build update-scripts');
      log.dim(`Target: ${cwd}`);

      const statuses = compareScripts(cwd);
      const needsUpdate = statuses.filter((s) => s.exists && s.contentDiffers);
      const missing = statuses.filter((s) => !s.exists);

      console.log('');
      for (const s of statuses) {
        if (!s.exists) {
          console.log(`  ${kleur.yellow('!')} ${s.name.padEnd(25)} ${kleur.gray('not present (run `init`)')}`);
        } else if (!s.contentDiffers) {
          console.log(
            `  ${kleur.green('✓')} ${s.name.padEnd(25)} ${kleur.gray(`v${s.userVersion || 'unknown'} (up to date)`)}`
          );
        } else {
          console.log(
            `  ${kleur.cyan('↑')} ${s.name.padEnd(25)} ${kleur.gray(
              `v${s.userVersion || 'unknown'} → v${s.templateVersion || '?'} (update available)`
            )}`
          );
        }
      }
      console.log('');

      if (missing.length) {
        log.dim(
          `${missing.length} script(s) missing — run \`npx local-expo-build init\` to scaffold them.`
        );
      }

      if (!needsUpdate.length) {
        log.ok('All scripts are up to date.');
        return;
      }

      if (dryRun) {
        log.warn(`[dry-run] ${needsUpdate.length} script(s) would be overwritten:`);
        for (const s of needsUpdate) log.dim(`  - ${path.relative(cwd, s.userPath).replace(/\\/g, '/')}`);
        return;
      }

      let shouldApply = Boolean(opts.yes);
      if (!shouldApply && process.stdin.isTTY) {
        shouldApply = await confirm({
          message: `Overwrite ${needsUpdate.length} script(s) with the latest bundled version?`,
          default: true,
        });
      } else if (!process.stdin.isTTY && !opts.yes) {
        log.warn('Non-TTY environment and --yes not passed; skipping update.');
        log.dim(`Run: npx local-expo-build update-scripts --yes`);
        return;
      }

      if (!shouldApply) {
        log.dim('Aborted. Run again with --yes to apply.');
        return;
      }

      applyScriptUpdates(needsUpdate);
      for (const s of needsUpdate) {
        log.ok(`Updated ${path.relative(cwd, s.userPath).replace(/\\/g, '/')} → v${s.templateVersion || '?'}`);
      }
      log.ok(`${needsUpdate.length} script(s) refreshed.`);
    });
}

// Re-export for tests / tooling that imported from here before.
export { TEMPLATE_SCRIPTS };

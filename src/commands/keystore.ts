import { Command } from 'commander';
import { getCtx } from '../util/ctx';
import { log } from '../util/log';
import { ensureKeystore } from '../core/keystore';
import { importExistingKeystore } from '../core/keystore/existing';
import { generateKeystore } from '../core/keystore/generate';
import { fetchKeystoreFromEas } from '../core/keystore/easFetch';

/**
 * `--dry-run` must never mutate the project. Every keystore subcommand honors
 * it by announcing the action and returning before any provider runs (keytool,
 * file copies, keystore.properties/credentials.json/.gitignore writes).
 */
function dryRunKeystore(what: string): void {
  log.dim(`[dry-run] would run: ${what} — no changes written.`);
}

export function registerKeystoreCommand(program: Command): void {
  const ks = program.command('keystore').description('Manage Android signing keystore');

  ks.command('setup')
    .description('Interactive: choose existing/generate/EAS')
    .action(async (_opts, cmd) => {
      const { cwd, dryRun } = getCtx(cmd);
      if (dryRun) {
        dryRunKeystore('keystore setup (interactive provider picker)');
        return;
      }
      await ensureKeystore(cwd);
    });

  ks.command('import')
    .description('Register an existing .jks file')
    .action(async (_opts, cmd) => {
      const { cwd, dryRun } = getCtx(cmd);
      if (dryRun) {
        dryRunKeystore('keystore import (register an existing .jks)');
        return;
      }
      await ensureKeystore(cwd, 'existing');
    });

  ks.command('create')
    .description('Generate a new keystore via keytool')
    .action(async (_opts, cmd) => {
      const { cwd, dryRun } = getCtx(cmd);
      if (dryRun) {
        dryRunKeystore('keystore create (generate a new keystore via keytool)');
        return;
      }
      await ensureKeystore(cwd, 'generate');
    });

  ks.command('fetch')
    .description('Fetch keystore via `eas credentials` (interactive)')
    .action(async (_opts, cmd) => {
      const { cwd, dryRun } = getCtx(cmd);
      if (dryRun) {
        dryRunKeystore('keystore fetch (pull keystore via eas credentials)');
        return;
      }
      await ensureKeystore(cwd, 'eas');
    });

  ks.command('rehydrate')
    .description('Recreate keystore.properties (and copy .jks into android/app/) from credentials.json')
    .option('--move', 'delete the source .jks after copying into android/app/')
    .action(async (opts, cmd) => {
      const { cwd, dryRun } = getCtx(cmd);
      if (dryRun) {
        dryRunKeystore(
          `keystore rehydrate (recreate keystore.properties from credentials.json${opts.move ? ' --move' : ''})`
        );
        return;
      }
      await ensureKeystore(cwd, 'rehydrate', { rehydrate: { move: Boolean(opts.move) } });
    });

  // Silence unused warnings — providers referenced by ensureKeystore
  void importExistingKeystore;
  void generateKeystore;
  void fetchKeystoreFromEas;
}

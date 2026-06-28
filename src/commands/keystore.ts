import { Command } from 'commander';
import { getCtx } from '../util/ctx';
import { ensureKeystore } from '../core/keystore';
import { importExistingKeystore } from '../core/keystore/existing';
import { generateKeystore } from '../core/keystore/generate';
import { fetchKeystoreFromEas } from '../core/keystore/easFetch';

export function registerKeystoreCommand(program: Command): void {
  const ks = program.command('keystore').description('Manage Android signing keystore');

  ks.command('setup')
    .description('Interactive: choose existing/generate/EAS')
    .action(async (_opts, cmd) => {
      const { cwd } = getCtx(cmd);
      await ensureKeystore(cwd);
    });

  ks.command('import')
    .description('Register an existing .jks file')
    .action(async (_opts, cmd) => {
      const { cwd } = getCtx(cmd);
      await ensureKeystore(cwd, 'existing');
    });

  ks.command('create')
    .description('Generate a new keystore via keytool')
    .action(async (_opts, cmd) => {
      const { cwd } = getCtx(cmd);
      await ensureKeystore(cwd, 'generate');
    });

  ks.command('fetch')
    .description('Fetch keystore via `eas credentials` (interactive)')
    .action(async (_opts, cmd) => {
      const { cwd } = getCtx(cmd);
      await ensureKeystore(cwd, 'eas');
    });

  ks.command('rehydrate')
    .description('Recreate keystore.properties (and copy .jks into android/app/) from credentials.json')
    .option('--move', 'delete the source .jks after copying into android/app/')
    .action(async (opts, cmd) => {
      const { cwd } = getCtx(cmd);
      await ensureKeystore(cwd, 'rehydrate', { rehydrate: { move: Boolean(opts.move) } });
    });

  // Silence unused warnings — providers referenced by ensureKeystore
  void importExistingKeystore;
  void generateKeystore;
  void fetchKeystoreFromEas;
}

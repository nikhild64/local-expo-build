import { select } from '@inquirer/prompts';
import { readKeystoreProps } from '../setupSigning';
import { writeCredentialsJson } from '../writeCredentialsJson';
import { importExistingKeystore } from './existing';
import { generateKeystore } from './generate';
import { fetchKeystoreFromEas } from './easFetch';
import { findRehydrateCandidate, rehydrateFromCredentialsJson, RehydrateOpts } from './rehydrate';
import { ensureGitignoreEntries } from '../../util/gitignore';
import { log } from '../../util/log';

export type KeystoreProvider = 'existing' | 'generate' | 'eas' | 'rehydrate';

export interface EnsureKeystoreOpts {
  /** Forwarded to rehydrate provider; ignored by others. */
  rehydrate?: RehydrateOpts;
}

export async function ensureKeystore(
  cwd: string,
  forceProvider?: KeystoreProvider,
  opts: EnsureKeystoreOpts = {}
): Promise<void> {
  if (!forceProvider) {
    const existing = readKeystoreProps(cwd);
    if (existing) {
      log.ok(`keystore.properties already present (alias=${existing.keyAlias}) — skipping.`);
      ensureGitignoreEntries(cwd, ['keystore.properties', '*.jks', 'credentials.json']);
      writeCredentialsJson(cwd, existing);
      return;
    }
  }

  const rehydrateAvailable = forceProvider === 'rehydrate' || !!findRehydrateCandidate(cwd);

  type ProviderChoice = { name: string; value: KeystoreProvider };
  const choices: ProviderChoice[] = [];
  if (rehydrateAvailable) {
    choices.push({
      name: 'Rehydrate from credentials.json (recommended — no password re-entry)',
      value: 'rehydrate',
    });
  }
  choices.push({ name: 'Use an existing .jks file', value: 'existing' });
  choices.push({ name: 'Generate a new keystore (keytool)', value: 'generate' });
  choices.push({ name: 'Fetch from EAS credentials', value: 'eas' });

  const provider: KeystoreProvider =
    forceProvider ??
    (await select({
      message: 'How would you like to set up the Android signing keystore?',
      choices,
    }));

  switch (provider) {
    case 'rehydrate':
      await rehydrateFromCredentialsJson(cwd, opts.rehydrate);
      break;
    case 'existing':
      await importExistingKeystore(cwd);
      break;
    case 'generate':
      await generateKeystore(cwd);
      break;
    case 'eas':
      await fetchKeystoreFromEas(cwd);
      break;
  }

  ensureGitignoreEntries(cwd, ['keystore.properties', '*.jks', 'credentials.json']);

  // 'eas' provider only opens the EAS credentials menu; it does NOT populate
  // keystore.properties (user must re-run `keystore import`). For 'existing'
  // and 'generate', keystore.properties is now written — sync credentials.json.
  const finalProps = readKeystoreProps(cwd);
  if (finalProps) {
    writeCredentialsJson(cwd, finalProps);
  }
}

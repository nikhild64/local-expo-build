import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { confirm, input, password } from '@inquirer/prompts';
import { writeKeystoreProps } from '../setupSigning';
import { log } from '../../util/log';

interface CredentialsMatch {
  keyAlias: string;
  storePassword: string;
  keyPassword: string;
  /** How the match was established — surfaced in logs so the user can verify. */
  matchKind: 'same-path' | 'same-content';
}

/**
 * Looks for an `android.keystore` block in `credentials.json` that describes
 * the same physical `.jks` the user just pointed at. Returns the passwords +
 * alias so we don't have to re-prompt the user for values they already have
 * on disk.
 *
 * Two ways to match:
 *  - **same-path:** credentials.json's keystorePath resolves to the same
 *    absolute path the user provided.
 *  - **same-content:** the bytes match (sha1). Handles the common case where
 *    EAS dropped two copies (one at project root, one at credentials/android/)
 *    and the user pointed at either.
 *
 * Returns null when credentials.json is missing/incomplete OR the .jks it
 * references doesn't match the one being imported — both are signals that
 * the user may be importing a *different* keystore and the passwords should
 * not be auto-reused.
 */
function findCredentialsMatchForJks(cwd: string, absJksPath: string): CredentialsMatch | null {
  const credPath = path.join(cwd, 'credentials.json');
  if (!fs.existsSync(credPath)) return null;

  let cred: any;
  try {
    cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch {
    return null;
  }
  const ks = cred?.android?.keystore;
  if (
    !ks ||
    typeof ks.keystorePath !== 'string' ||
    typeof ks.keystorePassword !== 'string' ||
    typeof ks.keyAlias !== 'string' ||
    typeof ks.keyPassword !== 'string'
  ) {
    return null;
  }

  const credJksAbs = path.resolve(cwd, ks.keystorePath);
  const build = (matchKind: CredentialsMatch['matchKind']): CredentialsMatch => ({
    keyAlias: ks.keyAlias,
    storePassword: ks.keystorePassword,
    keyPassword: ks.keyPassword,
    matchKind,
  });

  if (path.resolve(credJksAbs) === path.resolve(absJksPath)) {
    return build('same-path');
  }
  if (fs.existsSync(credJksAbs)) {
    try {
      if (sha1Of(credJksAbs) === sha1Of(absJksPath)) return build('same-content');
    } catch {
      // hashing failed (permission, race) — fall through to prompts
    }
  }
  return null;
}

function sha1Of(p: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

export async function importExistingKeystore(cwd: string): Promise<void> {
  const srcPath = await input({
    message: 'Path to your existing .jks file (absolute or relative to project):',
    validate: (v) => (fs.existsSync(path.resolve(cwd, v)) ? true : 'File does not exist'),
  });
  const absSrc = path.resolve(cwd, srcPath);
  const filename = path.basename(absSrc);
  const dest = path.join(cwd, 'android', 'app', filename);
  const rootBackup = path.join(cwd, filename);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (path.resolve(dest) !== absSrc) {
    fs.copyFileSync(absSrc, dest);
    log.ok(`Copied keystore → ${path.relative(cwd, dest).replace(/\\/g, '/')}`);
  }
  // Belt-and-suspenders: keep a copy at project root so the .jks survives
  // `expo prebuild --clean` wiping android/. setupSigning's recovery step
  // looks here as a fallback. Gitignored via the `*.jks` entry.
  if (path.resolve(rootBackup) !== absSrc) {
    fs.copyFileSync(absSrc, rootBackup);
    log.dim(`Backup → ${filename} (project root, gitignored)`);
  }

  let keyAlias: string;
  let storePassword: string;
  let keyPassword: string;

  const credMatch = findCredentialsMatchForJks(cwd, absSrc);
  if (credMatch) {
    log.ok(
      `Found credentials.json matching this .jks (${credMatch.matchKind}) — alias=${credMatch.keyAlias}`
    );
    const usePrefilled = await confirm({
      message: 'Reuse the passwords + alias from credentials.json (skip prompts)?',
      default: true,
    });
    if (usePrefilled) {
      keyAlias = credMatch.keyAlias;
      storePassword = credMatch.storePassword;
      keyPassword = credMatch.keyPassword;
    } else {
      keyAlias = await input({ message: 'Key alias:', default: credMatch.keyAlias });
      storePassword = await password({ message: 'Keystore password:', mask: '*' });
      keyPassword = await password({
        message: 'Key password (often same as keystore password):',
        mask: '*',
      });
    }
  } else {
    keyAlias = await input({ message: 'Key alias:', default: 'release' });
    storePassword = await password({ message: 'Keystore password:', mask: '*' });
    keyPassword = await password({
      message: 'Key password (often same as keystore password):',
      mask: '*',
    });
  }

  writeKeystoreProps(cwd, {
    storeFile: filename,
    storePassword,
    keyAlias,
    keyPassword,
  });
  log.ok('keystore.properties written.');
}

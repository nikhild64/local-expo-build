import fs from 'fs';
import path from 'path';
import { KeystoreProps } from './setupSigning';
import { log } from '../util/log';

/**
 * Scaffolds (or updates) credentials.json at the project root from the values
 * in keystore.properties. Used by EAS submit / cloud builds when
 * credentialsSource is "local" — see
 * https://docs.expo.dev/app-signing/local-credentials/
 *
 * - Path points at `android/app/<storeFile>` to stay in lock-step with
 *   keystore.properties (the Gradle release signingConfig reads the same file).
 * - Merges into an existing credentials.json so any `ios` block is preserved.
 * - Overwrites a malformed credentials.json (we can't safely merge garbage).
 * - Idempotent: writing the same values twice is a no-op on disk content.
 *
 * SECURITY: credentials.json contains plaintext keystore passwords. The
 * keystore setup flow adds it to .gitignore; do NOT commit it.
 */
export function writeCredentialsJson(cwd: string, props: KeystoreProps): void {
  const credPath = path.join(cwd, 'credentials.json');
  const keystorePath = `android/app/${props.storeFile}`.replace(/\\/g, '/');

  let existing: any = {};
  if (fs.existsSync(credPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
        existing = {};
      }
    } catch {
      log.warn('credentials.json was malformed — overwriting.');
      existing = {};
    }
  }

  existing.android = existing.android || {};
  existing.android.keystore = {
    keystorePath,
    keystorePassword: props.storePassword,
    keyAlias: props.keyAlias,
    keyPassword: props.keyPassword,
  };

  fs.writeFileSync(credPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  log.ok(`Wrote credentials.json (keystorePath=${keystorePath})`);
}

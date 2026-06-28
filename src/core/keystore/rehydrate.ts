import fs from 'fs';
import path from 'path';
import { writeKeystoreProps, KeystoreProps } from '../setupSigning';
import { log } from '../../util/log';

/**
 * A "rehydrate candidate" is the state you have after running
 * `eas credentials` and choosing "Download credentials from EAS to
 * credentials.json": a project-root credentials.json with all four required
 * keystore fields, plus the .jks file it references actually on disk.
 *
 * From that we can derive everything `keystore.properties` needs — without
 * asking the user to re-enter store/key passwords — and copy the .jks into
 * android/app/ where Gradle's signingConfig expects it.
 */
export interface RehydrateCandidate {
  credPath: string;
  jksSourceAbs: string;
  storeFile: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
}

export function findRehydrateCandidate(cwd: string): RehydrateCandidate | null {
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

  const jksSourceAbs = path.resolve(cwd, ks.keystorePath);
  if (!fs.existsSync(jksSourceAbs)) return null;

  return {
    credPath,
    jksSourceAbs,
    storeFile: path.basename(jksSourceAbs),
    storePassword: ks.keystorePassword,
    keyAlias: ks.keyAlias,
    keyPassword: ks.keyPassword,
  };
}

export interface RehydrateOpts {
  /**
   * Delete the source .jks after a successful copy. Off by default (safer:
   * keeps a backup at the original location that would survive a future
   * `expo prebuild --clean`). Turn on if you want a clean project root.
   */
  move?: boolean;
}

/**
 * Copies the .jks referenced by credentials.json into android/app/ (if not
 * already there) and writes keystore.properties from the same source.
 *
 * Idempotent: re-running on an already-rehydrated project copies nothing
 * (paths match) and rewrites keystore.properties with the same values.
 */
export async function rehydrateFromCredentialsJson(
  cwd: string,
  opts: RehydrateOpts = {}
): Promise<void> {
  const cand = findRehydrateCandidate(cwd);
  if (!cand) {
    throw new Error(
      'Cannot rehydrate: credentials.json is missing/incomplete or the referenced .jks was not found. ' +
        'Run `expo-local-build keystore fetch` to download credentials from EAS first, ' +
        'or use `keystore import|create` for a manual flow.'
    );
  }

  const destDir = path.join(cwd, 'android', 'app');
  const destAbs = path.join(destDir, cand.storeFile);
  const sourceMatchesDest = path.resolve(cand.jksSourceAbs) === path.resolve(destAbs);

  fs.mkdirSync(destDir, { recursive: true });
  if (!sourceMatchesDest) {
    fs.copyFileSync(cand.jksSourceAbs, destAbs);
    log.ok(
      `Copied ${path.relative(cwd, cand.jksSourceAbs).replace(/\\/g, '/')} → ` +
        `${path.relative(cwd, destAbs).replace(/\\/g, '/')}`
    );
  } else {
    log.dim(`.jks already at ${path.relative(cwd, destAbs).replace(/\\/g, '/')} — skipped copy.`);
  }

  const props: KeystoreProps = {
    storeFile: cand.storeFile,
    storePassword: cand.storePassword,
    keyAlias: cand.keyAlias,
    keyPassword: cand.keyPassword,
  };
  writeKeystoreProps(cwd, props);
  log.ok(`keystore.properties written from credentials.json (alias=${props.keyAlias}).`);

  if (opts.move && !sourceMatchesDest) {
    try {
      fs.rmSync(cand.jksSourceAbs);
      log.ok(`Removed source ${path.relative(cwd, cand.jksSourceAbs).replace(/\\/g, '/')} (--move).`);
    } catch (err: any) {
      log.warn(
        `Could not remove source ${path.relative(cwd, cand.jksSourceAbs)}: ${err?.message || err}. ` +
          `The copy at android/app/ is in place; you can delete the source manually.`
      );
    }
  }
}

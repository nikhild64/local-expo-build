import fs from 'fs';
import path from 'path';
import { log } from '../util/log';

export interface SetupSigningOpts {
  cwd: string;
}

/**
 * `expo prebuild` (especially with --clean or after accepting the "android
 * project is malformed, clear and reinitialize?" prompt) wipes the entire
 * android/ directory, including any .jks we previously copied into
 * android/app/. Before injecting the release signingConfig, we make sure the
 * keystore actually exists at android/app/<storeFile> by copying it back from
 * a stable source location outside android/.
 *
 * Recovery priority:
 *   1. credentials.json's keystorePath  (most authoritative)
 *   2. <cwd>/credentials/android/<storeFile>  (EAS download default)
 *   3. <cwd>/credentials/android/keystore.jks (EAS download fallback name)
 *   4. <cwd>/<storeFile>                      (project-root convention)
 */
function ensureKeystoreInAndroidApp(cwd: string, storeFile: string): void {
  const destDir = path.join(cwd, 'android', 'app');
  const dest = path.join(destDir, storeFile);
  if (isNonEmptyFile(dest)) return;

  const candidates: string[] = [];

  const credPath = path.join(cwd, 'credentials.json');
  if (fs.existsSync(credPath)) {
    try {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      const ksPath = cred?.android?.keystore?.keystorePath;
      if (typeof ksPath === 'string' && ksPath.trim()) {
        candidates.push(path.resolve(cwd, ksPath));
      }
    } catch {
      // ignore malformed credentials.json — other candidates may still work
    }
  }
  candidates.push(path.join(cwd, 'credentials', 'android', storeFile));
  candidates.push(path.join(cwd, 'credentials', 'android', 'keystore.jks'));
  candidates.push(path.join(cwd, storeFile));

  const found = candidates.find((p) => {
    const abs = path.resolve(p);
    return abs !== path.resolve(dest) && isNonEmptyFile(abs);
  });

  if (!found) {
    const tried = candidates
      .map((p) => '  - ' + path.relative(cwd, p).replace(/\\/g, '/'))
      .join('\n');
    throw new Error(
      `Keystore file ${path.relative(cwd, dest).replace(/\\/g, '/')} not found, ` +
        `and no recovery source available.\nTried:\n${tried}\n\n` +
        `If your android/ directory was just wiped by \`expo prebuild --clean\`, ` +
        `re-run \`npx expo-local-build keystore rehydrate\` (if you have credentials.json) ` +
        `or \`npx expo-local-build keystore import <path-to-jks>\` to restore it.`
    );
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(found, dest);
  log.ok(
    `Restored keystore: ${path.relative(cwd, found).replace(/\\/g, '/')} → ` +
      `${path.relative(cwd, dest).replace(/\\/g, '/')}`
  );
}

function isNonEmptyFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

export interface KeystoreProps {
  storeFile: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
}

export function readKeystoreProps(cwd: string): KeystoreProps | null {
  const p = path.join(cwd, 'keystore.properties');
  if (!fs.existsSync(p)) return null;
  const props: Record<string, string> = {};
  fs.readFileSync(p, 'utf8')
    .split('\n')
    .forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const i = t.indexOf('=');
      if (i === -1) return;
      props[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
  const missing = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'].filter(
    (k) => !props[k] || props[k] === 'FILL_IN'
  );
  if (missing.length) return null;
  return props as unknown as KeystoreProps;
}

export function writeKeystoreProps(cwd: string, props: KeystoreProps): void {
  const lines = [
    `storeFile=${props.storeFile}`,
    `storePassword=${props.storePassword}`,
    `keyAlias=${props.keyAlias}`,
    `keyPassword=${props.keyPassword}`,
  ];
  fs.writeFileSync(path.join(cwd, 'keystore.properties'), lines.join('\n') + '\n', 'utf8');
}

/**
 * Injects the release signingConfig into android/app/build.gradle.
 * Idempotent: if `signingConfigs.release` is already present, it's a no-op.
 */
export function setupSigning({ cwd }: SetupSigningOpts): void {
  const props = readKeystoreProps(cwd);
  if (!props) {
    throw new Error(
      `keystore.properties missing or incomplete at ${cwd}. ` +
        `Run "expo-local-build keystore create|import|fetch" first.`
    );
  }
  const gradlePath = path.join(cwd, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradlePath))
    throw new Error(`${gradlePath} not found — run prebuild first.`);

  // Survive `expo prebuild --clean` wiping android/: restore .jks from a stable source.
  ensureKeystoreInAndroidApp(cwd, props.storeFile);

  let gradle = fs.readFileSync(gradlePath, 'utf8');
  if (gradle.includes('signingConfigs.release')) {
    log.ok('Release signing config already present — skipping.');
    return;
  }

  const DEFAULT_SIGNING_BLOCK = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;

  const NEW_SIGNING_BLOCK = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            storeFile file('${props.storeFile}')
            storePassword '${props.storePassword}'
            keyAlias '${props.keyAlias}'
            keyPassword '${props.keyPassword}'
        }
    }`;

  if (!gradle.includes(DEFAULT_SIGNING_BLOCK)) {
    throw new Error(
      'Could not find the default signingConfigs block in build.gradle.\n' +
        'The file may have been manually edited; add the release signing config by hand.'
    );
  }
  gradle = gradle.replace(DEFAULT_SIGNING_BLOCK, NEW_SIGNING_BLOCK);

  const TOKEN = 'signingConfig signingConfigs.debug';
  const parts = gradle.split(TOKEN);
  if (parts.length >= 3) {
    gradle =
      parts[0] +
      TOKEN +
      parts[1] +
      'signingConfig signingConfigs.release' +
      parts.slice(2).join(TOKEN);
  } else {
    log.warn('Could not locate release buildType signing line — check build.gradle manually.');
  }
  fs.writeFileSync(gradlePath, gradle, 'utf8');
  log.ok(`Release signing config injected (alias=${props.keyAlias})`);
}

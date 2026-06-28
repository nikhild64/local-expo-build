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
        `re-run \`npx local-expo-build keystore rehydrate\` (if you have credentials.json) ` +
        `or \`npx local-expo-build keystore import <path-to-jks>\` to restore it.`
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
 * Finds the index of the matching closing brace for the `{` at or after
 * `startSearchFrom`. Returns -1 if no balanced match.
 *
 * Naive brace counter — does NOT understand groovy strings/comments, but for
 * Expo's generated build.gradle the signingConfigs/android blocks don't
 * contain braces inside strings, so this is safe in practice. If that ever
 * changes we'll need a real tokenizer.
 */
function findMatchingBrace(s: string, startSearchFrom: number): number {
  const openIdx = s.indexOf('{', startSearchFrom);
  if (openIdx === -1) return -1;
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findBlockStart(s: string, name: string): number {
  const re = new RegExp(`\\b${name}\\s*\\{`);
  const m = re.exec(s);
  return m ? m.index : -1;
}

function releaseBlock(props: KeystoreProps): string {
  return (
    `        release {\n` +
    `            storeFile file('${props.storeFile}')\n` +
    `            storePassword '${props.storePassword}'\n` +
    `            keyAlias '${props.keyAlias}'\n` +
    `            keyPassword '${props.keyPassword}'\n` +
    `        }\n`
  );
}

/**
 * Returns the gradle file with a `signingConfigs.release` block injected,
 * plus a label for which strategy succeeded. Returns null if all strategies
 * failed (caller throws with actionable error).
 *
 * Three strategies in order of fidelity:
 *  1. **exact-match**: today's behavior — replace the precise indented debug
 *     block. Preserves whitespace exactly. Fast path for unmodified Expo output.
 *  2. **block-inject**: tolerantly find `signingConfigs { ... }`, inject the
 *     release block before its closing brace. Survives whitespace / comment
 *     drift in the Expo template.
 *  3. **synthesize**: no `signingConfigs` block at all — insert one inside
 *     `android { ... }`. Survives Expo deciding to drop the default debug
 *     scaffold from prebuild output entirely.
 */
export function injectReleaseSigningConfig(
  gradle: string,
  props: KeystoreProps
): { gradle: string; strategy: 'exact-match' | 'block-inject' | 'synthesize' } | null {
  // ── Strategy 1: exact match (Expo's current default output) ──
  const EXACT_DEFAULT = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;
  const EXACT_REPLACEMENT = `    signingConfigs {
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
  if (gradle.includes(EXACT_DEFAULT)) {
    return { gradle: gradle.replace(EXACT_DEFAULT, EXACT_REPLACEMENT), strategy: 'exact-match' };
  }

  // ── Strategy 2: tolerant block inject ──
  // Find the signingConfigs block, jump to its matching closing brace, splice
  // the release block in just before it.
  const sigStart = findBlockStart(gradle, 'signingConfigs');
  if (sigStart !== -1) {
    const sigEnd = findMatchingBrace(gradle, sigStart);
    if (sigEnd !== -1) {
      // Insert release block right before the closing brace, preserving the
      // surrounding indentation.
      const before = gradle.slice(0, sigEnd);
      const after = gradle.slice(sigEnd);
      return { gradle: before + releaseBlock(props) + '    ' + after, strategy: 'block-inject' };
    }
  }

  // ── Strategy 3: synthesize a new signingConfigs block inside android { } ──
  const androidStart = findBlockStart(gradle, 'android');
  if (androidStart !== -1) {
    const openBrace = gradle.indexOf('{', androidStart);
    if (openBrace !== -1) {
      const before = gradle.slice(0, openBrace + 1);
      const after = gradle.slice(openBrace + 1);
      const block = `\n    signingConfigs {\n${releaseBlock(props)}    }\n`;
      return { gradle: before + block + after, strategy: 'synthesize' };
    }
  }

  return null;
}

/**
 * Rewires the release buildType to use signingConfigs.release. Tries the
 * historical pattern first (second occurrence of `signingConfig signingConfigs.debug`),
 * then a more tolerant regex-based search inside the `release { ... }` block.
 * No-op if `signingConfigs.release` is already wired up.
 */
export function wireReleaseBuildType(gradle: string): { gradle: string; changed: boolean } {
  const TOKEN = 'signingConfig signingConfigs.debug';
  const RELEASE = 'signingConfig signingConfigs.release';

  // Already wired in the release block?
  const releaseStart = findBlockStart(gradle, 'release');
  if (releaseStart !== -1) {
    const releaseEnd = findMatchingBrace(gradle, releaseStart);
    if (releaseEnd !== -1) {
      const releaseSlice = gradle.slice(releaseStart, releaseEnd);
      if (releaseSlice.includes(RELEASE)) return { gradle, changed: false };
    }
  }

  // Strategy A: historical "second occurrence" split.
  const parts = gradle.split(TOKEN);
  if (parts.length >= 3) {
    return {
      gradle:
        parts[0] + TOKEN + parts[1] + RELEASE + parts.slice(2).join(TOKEN),
      changed: true,
    };
  }

  // Strategy B: replace the signingConfig line inside the release { ... } block
  // (covers Expo templates that only have ONE `signingConfig signingConfigs.debug`).
  if (releaseStart !== -1) {
    const releaseEnd = findMatchingBrace(gradle, releaseStart);
    if (releaseEnd !== -1) {
      const before = gradle.slice(0, releaseStart);
      const slice = gradle.slice(releaseStart, releaseEnd);
      const after = gradle.slice(releaseEnd);
      if (slice.includes(TOKEN)) {
        return { gradle: before + slice.replace(TOKEN, RELEASE) + after, changed: true };
      }
    }
  }

  return { gradle, changed: false };
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
        `Run "local-expo-build keystore create|import|fetch" first.`
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

  const injected = injectReleaseSigningConfig(gradle, props);
  if (!injected) {
    throw new Error(
      'Could not inject the release signingConfig into android/app/build.gradle.\n' +
        'All three injection strategies failed (exact match, tolerant block inject, synthesize).\n' +
        'Your build.gradle may have been hand-edited or the Expo prebuild template changed shape.\n' +
        'Add a `release { storeFile file(\'' +
        props.storeFile +
        "') ... }` block under signingConfigs manually, then re-run."
    );
  }
  gradle = injected.gradle;
  if (injected.strategy !== 'exact-match') {
    log.dim(`Used '${injected.strategy}' strategy to inject signingConfig.`);
  }

  const wired = wireReleaseBuildType(gradle);
  if (!wired.changed) {
    log.warn(
      'Could not locate the release buildType signing line — check that ' +
        '`buildTypes { release { signingConfig signingConfigs.release } }` is set in build.gradle.'
    );
  }
  gradle = wired.gradle;

  fs.writeFileSync(gradlePath, gradle, 'utf8');
  log.ok(`Release signing config injected (alias=${props.keyAlias})`);
}

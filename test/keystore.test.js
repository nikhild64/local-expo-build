/**
 * Regression tests for the keystore fixes:
 *  - A4: importExistingKeystore can overwrite an existing configuration, while
 *        ensureKeystore keeps its fast-path no-op when no provider is forced.
 *  - A5: keystore providers gitignore secrets (keystore.properties, *.jks,
 *        *.p12, credentials.json) so the UI server routes are covered too.
 *  - B2: setupSigning re-syncs credentials.json when it swaps the storeFile to
 *        an alternate-extension keystore in android/app/.
 *  - B9: uploadLocalKeystoreToEas fails fast when expo.android.package is
 *        missing (before any network call).
 *
 * Run with: npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { ensureKeystore, importExistingKeystore } = require('../dist/core/keystore/index.js');
const { readKeystoreProps, writeKeystoreProps, setupSigning } = require('../dist/core/setupSigning.js');
const { uploadLocalKeystoreToEas } = require('../dist/core/keystore/easApiFetch.js');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leb-ks-'));
}

function writeProps(dir, storeFile) {
  writeKeystoreProps(dir, {
    storeFile,
    storePassword: 'sp123',
    keyAlias: 'release',
    keyPassword: 'kp123',
  });
}

function writeFakeJks(dir, relPath) {
  const abs = path.resolve(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'fake-keystore-bytes');
  return abs;
}

function readGitignore(dir) {
  const p = path.join(dir, '.gitignore');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

const GITIGNORE_ENTRIES = ['keystore.properties', '*.jks', '*.p12', 'credentials.json'];

describe('keystore gitignore coverage (A1/A5)', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('importExistingKeystore gitignores all secret files, including *.p12', async () => {
    writeFakeJks(dir, 'release.p12');
    await importExistingKeystore(dir, {
      srcPath: 'release.p12',
      keyAlias: 'release',
      storePassword: 'sp123',
      keyPassword: 'sp123',
    });

    const gi = readGitignore(dir);
    for (const entry of GITIGNORE_ENTRIES) {
      assert.ok(gi.includes(entry), `.gitignore should contain "${entry}"`);
    }
  });
});

describe('keystore overwrite behavior (A4)', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('ensureKeystore keeps the fast-path no-op when a keystore exists and no provider is forced', async () => {
    writeProps(dir, 'old.jks');
    writeFakeJks(dir, 'android/app/old.jks');

    // Must return without prompting and without clobbering the config.
    await ensureKeystore(dir);
    const props = readKeystoreProps(dir);
    assert.ok(props);
    assert.strictEqual(props.storeFile, 'old.jks');
  });

  it('importExistingKeystore with params replaces an existing configuration', async () => {
    writeProps(dir, 'old.jks');
    writeFakeJks(dir, 'android/app/old.jks');
    writeFakeJks(dir, 'new-key.p12');

    await importExistingKeystore(dir, {
      srcPath: 'new-key.p12',
      keyAlias: 'release',
      storePassword: 'sp123',
      keyPassword: 'sp123',
    });

    const props = readKeystoreProps(dir);
    assert.ok(props);
    assert.strictEqual(props.storeFile, 'new-key.p12');

    const cred = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
    assert.strictEqual(cred.android.keystore.keystorePath, 'android/app/new-key.p12');
  });
});

describe('storeFile swap keeps credentials.json in sync (B2)', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('setupSigning rewrites credentials.json when restoring an alternate-extension keystore', () => {
    // Configured storeFile is release.p12 (missing), but release.jks exists in
    // android/app/ — the restore path should swap props AND credentials.json.
    writeProps(dir, 'release.p12');
    writeFakeJks(dir, 'android/app/release.jks');
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        android: {
          keystore: {
            keystorePath: 'android/app/release.p12',
            keystorePassword: 'sp123',
            keyAlias: 'release',
            keyPassword: 'kp123',
          },
        },
      }, null, 2)
    );

    const gradlePath = path.join(dir, 'android', 'app', 'build.gradle');
    fs.writeFileSync(gradlePath, [
      'apply plugin: "com.android.application"',
      'android {',
      "    namespace 'com.example.app'",
      '    defaultConfig {',
      '        versionCode 1',
      '        versionName "1.0"',
      '    }',
      '}',
      '',
    ].join('\n'));

    setupSigning({ cwd: dir });

    const props = readKeystoreProps(dir);
    assert.strictEqual(props.storeFile, 'release.jks');
    const cred = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
    assert.strictEqual(cred.android.keystore.keystorePath, 'android/app/release.jks');
  });
});

describe('EAS keystore upload validation (B9)', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('fails fast on a missing expo.android.package before any network call', async () => {
    // app.json with NO android.package
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify({ expo: { name: 'App', slug: 'app', version: '1.0.0' } }, null, 2)
    );
    writeProps(dir, 'release.jks');
    writeFakeJks(dir, 'android/app/release.jks');

    await assert.rejects(
      () => uploadLocalKeystoreToEas(dir, 'project-id-123'),
      /Missing expo\.android\.package/
    );
  });

  it('still requires an existing keystore file after the package check passes', async () => {
    // package present, but the referenced keystore file is missing on disk
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify(
        { expo: { name: 'App', slug: 'app', version: '1.0.0', android: { package: 'com.example.app' } } },
        null, 2
      )
    );
    writeProps(dir, 'release.jks');
    // no keystore file on disk

    await assert.rejects(
      () => uploadLocalKeystoreToEas(dir, 'project-id-123'),
      /was not found on disk/
    );
  });
});

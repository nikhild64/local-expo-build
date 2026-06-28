/**
 * Tests for findRehydrateCandidate — detects whether credentials.json +
 * .jks pair can be auto-bound without re-prompting for passwords.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { findRehydrateCandidate } = require('../dist/core/keystore/rehydrate.js');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leb-rehydrate-'));
}

function writeCredentials(dir, keystorePath) {
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    android: {
      keystore: {
        keystorePath,
        keystorePassword: 'pw1',
        keyAlias: 'release',
        keyPassword: 'pw2',
      },
    },
  }, null, 2));
}

function writeFakeJks(dir, relPath) {
  const abs = path.resolve(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'fake-jks-content');
  return abs;
}

describe('findRehydrateCandidate', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns null when credentials.json is missing', () => {
    assert.strictEqual(findRehydrateCandidate(dir), null);
  });

  it('returns null when credentials.json is malformed JSON', () => {
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{not json');
    assert.strictEqual(findRehydrateCandidate(dir), null);
  });

  it('returns null when keystore fields are incomplete', () => {
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
      android: { keystore: { keystorePath: 'x.jks' } },
    }));
    assert.strictEqual(findRehydrateCandidate(dir), null);
  });

  it('returns null when the referenced .jks does not exist', () => {
    writeCredentials(dir, 'credentials/android/keystore.jks');
    // intentionally don't write the .jks
    assert.strictEqual(findRehydrateCandidate(dir), null);
  });

  it('returns candidate when credentials.json + referenced .jks both exist', () => {
    writeFakeJks(dir, 'credentials/android/keystore.jks');
    writeCredentials(dir, 'credentials/android/keystore.jks');
    const result = findRehydrateCandidate(dir);
    assert.ok(result);
    assert.strictEqual(result.storeFile, 'keystore.jks');
    assert.strictEqual(result.storePassword, 'pw1');
    assert.strictEqual(result.keyAlias, 'release');
    assert.strictEqual(result.keyPassword, 'pw2');
  });

  it('storeFile is the basename of the referenced .jks (not the full path)', () => {
    writeFakeJks(dir, 'some/weird/nested/path/myapp.jks');
    writeCredentials(dir, 'some/weird/nested/path/myapp.jks');
    const result = findRehydrateCandidate(dir);
    assert.ok(result);
    assert.strictEqual(result.storeFile, 'myapp.jks');
  });
});

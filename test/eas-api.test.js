const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { resolveEasAuth } = require('../dist/core/eas/api.js');
const { isValidKeystoreBuffer } = require('../dist/core/keystore/easApiFetch.js');

describe('EAS API helpers', () => {
  it('prefers EXPO_TOKEN over the Expo session file', () => {
    const previous = process.env.EXPO_TOKEN;
    process.env.EXPO_TOKEN = 'test-token';
    assert.deepStrictEqual(resolveEasAuth(), { token: 'test-token' });
    if (previous === undefined) delete process.env.EXPO_TOKEN;
    else process.env.EXPO_TOKEN = previous;
  });

  it('returns null when no token or Expo session is available', () => {
    const previous = process.env.EXPO_TOKEN;
    delete process.env.EXPO_TOKEN;
    const originalHome = os.homedir;
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-empty-home-'));
    os.homedir = () => emptyHome;
    try { assert.strictEqual(resolveEasAuth(), null); }
    finally {
      os.homedir = originalHome;
      fs.rmSync(emptyHome, { recursive: true, force: true });
      if (previous !== undefined) process.env.EXPO_TOKEN = previous;
    }
  });

  it('validates JKS and PKCS12 magic bytes only', () => {
    assert.strictEqual(isValidKeystoreBuffer(Buffer.from([0xfe, 0xed, 0xfe, 0xed])), true);
    assert.strictEqual(isValidKeystoreBuffer(Buffer.from([0x30, 0x82, 0x01, 0x00])), true);
    assert.strictEqual(isValidKeystoreBuffer(Buffer.alloc(0)), false);
    assert.strictEqual(isValidKeystoreBuffer(Buffer.from([1, 2, 3, 4])), false);
  });
});
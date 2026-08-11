const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  formatCliUpdateMessage,
  forwardCliArgv,
  isCliUpdateAvailable,
  resolveLatestPublishedVersion,
} = require('../dist/util/checkCliUpdate');
const { formatCliInvoke, getRunnerInvocation } = require('../dist/util/resolveProjectBin');

describe('checkCliUpdate', () => {
  it('isCliUpdateAvailable when registry is newer', () => {
    assert.equal(isCliUpdateAvailable('0.4.1', '0.4.2'), true);
    assert.equal(isCliUpdateAvailable('0.4.2', '0.4.2'), false);
    assert.equal(isCliUpdateAvailable('0.4.2', '0.4.1'), false);
  });

  it('formatCliUpdateMessage suggests bunx for bun projects', () => {
    const msg = formatCliUpdateMessage({ current: '0.4.1', latest: '0.4.2' }, 'bun', 'init');
    assert.match(msg, /0\.4\.1 → 0\.4\.2/);
    assert.match(msg, /bunx local-expo-build@latest init/);
  });

  it('formatCliInvoke uses npx by default', () => {
    assert.equal(formatCliInvoke('npm', 'doctor'), 'npx local-expo-build@latest doctor');
  });

  it('forwardCliArgv drops the package name when present', () => {
    assert.deepEqual(
      forwardCliArgv(['node', 'cli.js', 'local-expo-build', 'init', '--force']),
      ['init', '--force']
    );
    assert.deepEqual(forwardCliArgv(['node', 'cli.js', 'init', '--force']), ['init', '--force']);
  });

  it('getRunnerInvocation uses bunx for bun', () => {
    assert.deepEqual(getRunnerInvocation('bun'), {
      command: 'bunx',
      args: ['local-expo-build@latest'],
    });
  });
});

describe('update-cache write resilience (D3)', () => {
  it('a failing cache write does not break resolveLatestPublishedVersion', async () => {
    // Point os.homedir() at a regular FILE so the cache mkdir fails (ENOTDIR),
    // simulating an unwritable/weird home directory (sandboxed CI, Nix,
    // read-only mounts).
    const homedirFile = path.join(os.tmpdir(), `leb-home-file-${process.pid}`);
    fs.writeFileSync(homedirFile, '');

    const origHomedir = os.homedir;
    const origFetch = global.fetch;
    try {
      os.homedir = () => homedirFile;
      // Deterministic registry response — no network required.
      global.fetch = async () => ({ ok: true, json: async () => ({ version: '99.9.9' }) });

      const latest = await resolveLatestPublishedVersion();
      assert.strictEqual(latest, '99.9.9', 'version should resolve despite the cache write failure');
    } finally {
      os.homedir = origHomedir;
      if (origFetch === undefined) delete global.fetch;
      else global.fetch = origFetch;
      try { fs.unlinkSync(homedirFile); } catch {}
    }
  });
});

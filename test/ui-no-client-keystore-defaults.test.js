/**
 * Source-scan lint test: the UI must not reimplement keystore generation logic
 * or hardcode keystore defaults. The single source of truth is the server's
 * GENERATE_DEFAULTS (src/core/keystore/autoSetup.ts), served to the UI via
 * GET /api/keystore/defaults; random passwords are generated server-side only.
 *
 * If this test fails, a client-side default or password scheme was reintroduced
 * — move it server-side (autoSetup.ts) instead of duplicating it in the UI.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');

describe('UI ships no client-side keystore generation logic', () => {
  it('app.js has no crypto-based password generation', () => {
    for (const needle of ['crypto.getRandomValues', 'toString(36)']) {
      assert.ok(
        !appJs.includes(needle),
        `app.js must not contain "${needle}" — keystore passwords are generated server-side (autoSetup.ts)`
      );
    }
  });

  it('app.js has no hardcoded keystore defaults', () => {
    // The shared generate defaults (filename, alias, identity) and the old
    // display fallbacks must not be hardcoded in the client.
    // Quoted forms only, so identifiers like the LocalExpoBuildFixChain UMD
    // namespace don't false-positive.
    const forbidden = ["'release.p12'", "'release.jks'", "'Release Signer'", "'LocalExpoBuild'", "'Unknown'"];
    for (const literal of forbidden) {
      assert.ok(
        !appJs.includes(literal),
        `app.js must not hardcode ${literal} — the server's GENERATE_DEFAULTS is the single source of truth`
      );
    }
    // No `|| 'release'`-style fallback assignments in the generate submit path.
    assert.ok(
      !/\|\|\s*'release'/.test(appJs),
      "app.js must not fall back to a hardcoded 'release' alias"
    );
  });

  it('app.js sources the generate defaults from the server', () => {
    assert.ok(
      appJs.includes('/api/keystore/defaults'),
      'app.js should prefill the Generate form from GET /api/keystore/defaults'
    );
  });

  it('index.html has no hardcoded generate-default values', () => {
    for (const literal of [
      'value="release.p12"',
      'value="release"',
      'value="Release Signer"',
      'value="Unknown"',
      'value="US"',
    ]) {
      assert.ok(
        !indexHtml.includes(literal),
        `index.html must not hardcode ${literal} — defaults come from the server`
      );
    }
  });
});

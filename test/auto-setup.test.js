/**
 * Unit tests for the shared keystore auto-setup chain (src/core/keystore/
 * autoSetup.ts) — the single implementation of the rehydrate → EAS fetch →
 * generate decision used by both the UI (via /api/keystore/auto-setup) and
 * the CLI (doctor --fix, the build pre-flight).
 *
 * The chain's inputs are file-based; EAS/network and keytool are stubbed by
 * monkeypatching module exports (the compiled CJS accesses the properties at
 * call time). Real credentials.json + .jks files exercise the rehydrate path.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoSetupKeystore, autoGenerateKeystore } = require('../dist/core/keystore/autoSetup.js');
const { readKeystoreProps, writeKeystoreProps } = require('../dist/core/setupSigning.js');

const rehydrateMod = require('../dist/core/keystore/rehydrate.js');
const easFetchMod = require('../dist/core/keystore/easApiFetch.js');
const generateMod = require('../dist/core/keystore/generate.js');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leb-autosetup-'));
}

/** A real rehydrate candidate: credentials.json + a .jks file on disk. */
function writeRehydrateCandidate(dir) {
  const jks = path.join(dir, 'credentials', 'android', 'release.jks');
  fs.mkdirSync(path.dirname(jks), { recursive: true });
  fs.writeFileSync(jks, 'fake-keystore-bytes');
  fs.writeFileSync(
    path.join(dir, 'credentials.json'),
    JSON.stringify(
      {
        android: {
          keystore: {
            keystorePath: 'credentials/android/release.jks',
            keystorePassword: 'sp123456',
            keyAlias: 'release',
            keyPassword: 'kp123456',
          },
        },
      },
      null,
      2
    )
  );
}

/** Simulates generateKeystore's file contract without running keytool. */
function stubGenerate(cwd, params = {}) {
  const filename = params.filename || 'release.p12';
  const storePassword = params.storePassword;
  fs.mkdirSync(path.join(cwd, 'android', 'app'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'android', 'app', filename), 'fake-p12');
  writeKeystoreProps(cwd, {
    storeFile: filename,
    storePassword,
    keyAlias: params.keyAlias || 'release',
    keyPassword: params.keyPassword || storePassword,
  });
}

/** Simulates fetchEasKeystore's file contract without any network call. */
function stubFetchEas(cwd, projectId, buildCredentialsId, overwrite, auth) {
  writeKeystoreProps(cwd, {
    storeFile: 'release.jks',
    storePassword: 'sp123456',
    keyAlias: 'release',
    keyPassword: 'kp123456',
  });
  return { storeFile: 'release.jks', keyAlias: 'release' };
}

const originals = {
  rehydrate: rehydrateMod.rehydrateFromCredentialsJson,
  fetchEas: easFetchMod.fetchEasKeystore,
  generate: generateMod.generateKeystore,
};

let dir;
beforeEach(() => {
  dir = tmpProject();
  rehydrateMod.rehydrateFromCredentialsJson = originals.rehydrate;
  easFetchMod.fetchEasKeystore = originals.fetchEas;
  generateMod.generateKeystore = originals.generate;
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  rehydrateMod.rehydrateFromCredentialsJson = originals.rehydrate;
  easFetchMod.fetchEasKeystore = originals.fetchEas;
  generateMod.generateKeystore = originals.generate;
});

describe('autoSetupKeystore — existing fast path', () => {
  it('returns provider "existing" without touching any provider', async () => {
    writeKeystoreProps(dir, {
      storeFile: 'release.p12',
      storePassword: 'sp123456',
      keyAlias: 'release',
      keyPassword: 'kp123456',
    });
    let touched = false;
    easFetchMod.fetchEasKeystore = async () => {
      touched = true;
      return stubFetchEas();
    };
    generateMod.generateKeystore = async () => {
      touched = true;
    };

    const result = await autoSetupKeystore(dir, { projectId: 'proj-1', auth: { token: 't' } });
    assert.strictEqual(result.provider, 'existing');
    assert.strictEqual(result.storeFile, 'release.p12');
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(touched, false);
  });
});

describe('autoSetupKeystore — rehydrate first', () => {
  it('rehydrates from credentials.json when a candidate is on disk', async () => {
    writeRehydrateCandidate(dir);
    generateMod.generateKeystore = async () => {
      throw new Error('generate should not run when rehydrate succeeds');
    };

    const result = await autoSetupKeystore(dir);
    assert.strictEqual(result.provider, 'rehydrate');
    assert.strictEqual(result.storeFile, 'release.jks');
    const props = readKeystoreProps(dir);
    assert.strictEqual(props.storePassword, 'sp123456');
    assert.deepStrictEqual(result.warnings, []);
  });

  it('falls through to generate when rehydrate fails, with a warning', async () => {
    writeRehydrateCandidate(dir);
    rehydrateMod.rehydrateFromCredentialsJson = async () => {
      throw new Error('credentials.json is corrupt');
    };
    generateMod.generateKeystore = stubGenerate;

    const result = await autoSetupKeystore(dir);
    assert.strictEqual(result.provider, 'generate');
    assert.ok(result.generatedPassword && result.generatedPassword.length >= 6);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /Rehydrate failed: credentials\.json is corrupt/);
  });
});

describe('autoSetupKeystore — EAS fetch', () => {
  it('fetches from EAS when linked and authenticated', async () => {
    let fetchArgs = null;
    easFetchMod.fetchEasKeystore = async (...args) => {
      fetchArgs = args;
      return stubFetchEas(...args);
    };
    generateMod.generateKeystore = async () => {
      throw new Error('generate should not run when EAS fetch succeeds');
    };

    const result = await autoSetupKeystore(dir, { projectId: 'proj-123', auth: { token: 'tok' } });
    assert.strictEqual(result.provider, 'eas');
    assert.strictEqual(result.storeFile, 'release.jks');
    // (cwd, projectId, buildCredentialsId, overwrite, auth)
    assert.strictEqual(fetchArgs[0], dir);
    assert.strictEqual(fetchArgs[1], 'proj-123');
    assert.strictEqual(fetchArgs[2], undefined);
    assert.strictEqual(fetchArgs[3], true, 'must overwrite the local copy');
    assert.deepStrictEqual(fetchArgs[4], { token: 'tok' });
    assert.deepStrictEqual(result.warnings, []);
  });

  it('skips EAS when the project is not linked (no projectId)', async () => {
    easFetchMod.fetchEasKeystore = async () => {
      throw new Error('fetch must not run without projectId');
    };
    generateMod.generateKeystore = stubGenerate;

    const result = await autoSetupKeystore(dir, { auth: { token: 'tok' } });
    assert.strictEqual(result.provider, 'generate');
    assert.deepStrictEqual(result.warnings, []);
  });

  it('skips EAS when auth is explicitly null', async () => {
    easFetchMod.fetchEasKeystore = async () => {
      throw new Error('fetch must not run without auth');
    };
    generateMod.generateKeystore = stubGenerate;

    const result = await autoSetupKeystore(dir, { projectId: 'proj-123', auth: null });
    assert.strictEqual(result.provider, 'generate');
    assert.deepStrictEqual(result.warnings, []);
  });

  it('falls through to generate when the EAS fetch fails, with a warning', async () => {
    easFetchMod.fetchEasKeystore = async () => {
      throw new Error('EAS has no Android keystore for this project yet.');
    };
    generateMod.generateKeystore = stubGenerate;

    const result = await autoSetupKeystore(dir, { projectId: 'proj-123', auth: { token: 'tok' } });
    assert.strictEqual(result.provider, 'generate');
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /EAS keystore fetch failed/);
  });
});

describe('autoSetupKeystore — local generation', () => {
  it('generates a keystore with a fresh password and returns it', async () => {
    const seen = [];
    generateMod.generateKeystore = async (cwd, params) => {
      seen.push(params);
      stubGenerate(cwd, params);
    };

    const result = await autoSetupKeystore(dir, { generateParams: { org: 'Acme' } });
    assert.strictEqual(result.provider, 'generate');
    assert.ok(result.generatedPassword && result.generatedPassword.length === 16);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(seen.length, 1);
    // The fresh random password always wins over caller-provided ones.
    assert.strictEqual(seen[0].storePassword, result.generatedPassword);
    assert.strictEqual(seen[0].keyPassword, result.generatedPassword);
    assert.strictEqual(seen[0].org, 'Acme');
    // The exact params used are returned so UI surfaces need no fallback.
    assert.deepStrictEqual(result.params, seen[0]);
    assert.strictEqual(result.params.filename, 'release.p12');
    assert.strictEqual(result.params.keyAlias, 'release');
    const props = readKeystoreProps(dir);
    assert.strictEqual(props.storePassword, result.generatedPassword);
  });

  it('rejects when generation fails (nothing left to fall back to)', async () => {
    generateMod.generateKeystore = async () => {
      throw new Error('keytool not found');
    };
    await assert.rejects(() => autoSetupKeystore(dir), /keytool not found/);
  });
});

describe('autoGenerateKeystore — shared auto defaults', () => {
  it('generates with the auto defaults and returns the shown-once password', async () => {
    const seen = [];
    generateMod.generateKeystore = async (cwd, params) => {
      seen.push(params);
      stubGenerate(cwd, params);
    };

    const result = await autoGenerateKeystore(dir);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].filename, 'release.p12');
    assert.strictEqual(seen[0].keyAlias, 'release');
    assert.strictEqual(seen[0].org, 'LocalExpoBuild');
    assert.strictEqual(seen[0].storePassword, result.generatedPassword);
    assert.strictEqual(seen[0].keyPassword, result.generatedPassword);
    assert.strictEqual(result.storeFile, 'release.p12');
    assert.strictEqual(result.keyAlias, 'release');
    assert.deepStrictEqual(result.params, seen[0], 'exact params used are returned');
    assert.ok(result.generatedPassword && result.generatedPassword.length === 16);
    const props = readKeystoreProps(dir);
    assert.strictEqual(props.storePassword, result.generatedPassword);
  });

  it('applies overrides but a fresh password always wins', async () => {
    const seen = [];
    generateMod.generateKeystore = async (cwd, params) => {
      seen.push(params);
      stubGenerate(cwd, params);
    };

    const result = await autoGenerateKeystore(dir, {
      filename: 'custom.p12',
      keyAlias: 'custom',
      storePassword: 'should-not-win',
    });
    assert.strictEqual(seen[0].filename, 'custom.p12');
    assert.strictEqual(seen[0].keyAlias, 'custom');
    assert.strictEqual(seen[0].storePassword, result.generatedPassword);
    assert.notStrictEqual(seen[0].storePassword, 'should-not-win');
    assert.deepStrictEqual(result.params, seen[0], 'exact params used are returned');
    assert.strictEqual(result.storeFile, 'custom.p12');
    assert.strictEqual(result.keyAlias, 'custom');
  });

  it('rejects when keytool generation fails', async () => {
    generateMod.generateKeystore = async () => {
      throw new Error('keytool not found');
    };
    await assert.rejects(() => autoGenerateKeystore(dir), /keytool not found/);
  });
});

/**
 * Unit tests for the UI Build & Fix chain (ui/fix-chain.js), exercised in
 * Node without a browser — the module is UMD, so it loads via require() and
 * every browser primitive (modal, alert, fetch, DOM state) is injected
 * through `deps`.
 *
 * Since the keystore decision moved server-side (src/core/keystore/
 * autoSetup.ts, exposed as one POST /api/keystore/auto-setup call), the chain
 * tests here cover the confirm gate, the package fix, and the single
 * auto-setup call — the keystore provider matrix itself is tested in
 * test/auto-setup.test.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  runFixChain,
  buildDefaultPackageName,
  missingPartsLabel,
  offerBuildAfterFixAll,
} = require('../ui/fix-chain.js');

/**
 * Builds a fake deps object. `api` records every request as { url, body }
 * (parsed JSON body, empty object when none) and returns { ok: true, data: {} }
 * unless `apiOverrides` maps a URL to a response. `confirm` returns true
 * unless overridden.
 */
function makeDeps({ confirm, apiOverrides, ...overrides } = {}) {
  const calls = [];
  const deps = {
    confirm: async () => true,
    alert: async (title, message, type) => calls.push(['alert', title]),
    api: async (url, options) => {
      let body = {};
      if (options && options.body) body = JSON.parse(options.body);
      calls.push(['api', url, body]);
      if (apiOverrides && Object.prototype.hasOwnProperty.call(apiOverrides, url)) {
        const resp = apiOverrides[url];
        if (resp instanceof Error) throw resp;
        return resp;
      }
      return { ok: true, data: {} };
    },
    folderName: 'My Cool App',
    ...overrides,
  };
  if (confirm !== undefined) deps.confirm = confirm;
  return { deps, calls };
}

describe('runFixChain — confirm gate', () => {
  it('is a no-op when nothing is missing (no confirm, no api calls)', async () => {
    const { deps, calls } = makeDeps();
    const result = await runFixChain({ needsPackage: false, needsKeystore: false }, deps);
    assert.deepStrictEqual(result, { ready: true });
    assert.deepStrictEqual(calls, []);
  });

  it('declining cancels without calling any fix API', async () => {
    const { deps, calls } = makeDeps({ confirm: async () => false });
    const result = await runFixChain({ needsPackage: true, needsKeystore: true }, deps);
    assert.deepStrictEqual(result, { ready: false, cancelled: true });
    assert.deepStrictEqual(calls, []);
  });

  it('asks with a human-readable list of the missing pieces', async () => {
    let seen = null;
    const { deps } = makeDeps({
      confirm: async (message) => {
        seen = message;
        return false;
      },
    });
    await runFixChain({ needsPackage: true, needsKeystore: true }, deps);
    assert.strictEqual(
      seen,
      'This project is missing the Android package name and a release signing keystore. Fix them automatically and start the build?'
    );
  });
});

describe('runFixChain — Android package fix', () => {
  it('posts the smart default package derived from the folder name', async () => {
    const { deps, calls } = makeDeps({ folderName: 'My Cool App' });
    const result = await runFixChain({ needsPackage: true, needsKeystore: false }, deps);
    assert.strictEqual(result.ready, true);
    const apiCalls = calls.filter(([kind]) => kind === 'api');
    assert.strictEqual(apiCalls.length, 1);
    assert.strictEqual(apiCalls[0][1], '/api/doctor/fix-package');
    assert.deepStrictEqual(apiCalls[0][2], { packageName: 'com.example.mycoolapp' });
  });

  it('stops (ready false, alert shown) when the package fix fails', async () => {
    const alerts = [];
    const { deps, calls } = makeDeps({
      apiOverrides: {
        '/api/doctor/fix-package': { ok: false, data: { error: 'app.json missing' } },
      },
      alert: async (title, message, type) => alerts.push([title, message, type]),
    });
    const result = await runFixChain({ needsPackage: true, needsKeystore: true }, deps);
    assert.strictEqual(result.ready, false);
    assert.deepStrictEqual(alerts, [
      ['Could not fix package name', 'app.json missing', 'error'],
    ]);
    // The keystore must not be attempted after the package fix failed.
    const apiUrls = calls.filter(([kind]) => kind === 'api').map(([, url]) => url);
    assert.deepStrictEqual(apiUrls, ['/api/doctor/fix-package']);
  });
});

describe('runFixChain — keystore auto-setup (single endpoint)', () => {
  it('calls /api/keystore/auto-setup exactly once when a keystore is needed', async () => {
    const { deps, calls } = makeDeps();
    const result = await runFixChain({ needsPackage: false, needsKeystore: true }, deps);
    assert.strictEqual(result.ready, true);
    // Default fake response has no storeFile/keyAlias — the chain passes null.
    assert.strictEqual(result.storeFile, null);
    assert.strictEqual(result.keyAlias, null);
    const apiCalls = calls.filter(([kind]) => kind === 'api');
    assert.strictEqual(apiCalls.length, 1);
    assert.strictEqual(apiCalls[0][1], '/api/keystore/auto-setup');
    assert.deepStrictEqual(apiCalls[0][2], {});
  });

  it('returns the generated password and keystore identity for the copy modal', async () => {
    const params = { filename: 'custom.p12', keyAlias: 'ship', storePassword: 'abc123def456', keyPassword: 'abc123def456' };
    const { deps } = makeDeps({
      apiOverrides: {
        '/api/keystore/auto-setup': {
          ok: true,
          data: { provider: 'generate', storeFile: 'custom.p12', keyAlias: 'ship', generatedPassword: 'abc123def456', params },
        },
      },
    });
    const result = await runFixChain({ needsPackage: false, needsKeystore: true }, deps);
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.generatedPassword, 'abc123def456');
    assert.strictEqual(result.storeFile, 'custom.p12');
    assert.strictEqual(result.keyAlias, 'ship');
    assert.deepStrictEqual(result.params, params);
  });

  it('reports ready without a password when a non-generate provider wins', async () => {
    const { deps } = makeDeps({
      apiOverrides: {
        '/api/keystore/auto-setup': {
          ok: true,
          data: { provider: 'rehydrate', storeFile: 'release.jks', keyAlias: 'release' },
        },
      },
    });
    const result = await runFixChain({ needsPackage: false, needsKeystore: true }, deps);
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.generatedPassword, null);
    assert.strictEqual(result.storeFile, 'release.jks');
    assert.strictEqual(result.keyAlias, 'release');
  });

  it('stops (ready false, alert shown) when auto-setup fails', async () => {
    const alerts = [];
    const { deps } = makeDeps({
      apiOverrides: {
        '/api/keystore/auto-setup': { ok: false, data: { error: 'keytool missing' } },
      },
      alert: async (title, message, type) => alerts.push([title, message, type]),
    });
    const result = await runFixChain({ needsPackage: false, needsKeystore: true }, deps);
    assert.strictEqual(result.ready, false);
    assert.deepStrictEqual(alerts, [
      ['Could not set up keystore', 'keytool missing', 'error'],
    ]);
  });
});

describe('offerBuildAfterFixAll (post-Fix All one-shot)', () => {
  function makeDeps(overrides = {}) {
    const calls = [];
    const deps = {
      choose: async (cfg) => {
        calls.push(['choose', cfg.title, cfg.confirmText]);
        return overrides.choice ?? 'none';
      },
      selectArtifact: async (kind) => calls.push(['selectArtifact', kind]),
      switchTab: async (tab) => calls.push(['switchTab', tab]),
      refresh: async () => calls.push(['refresh']),
      startBuild: async () => calls.push(['startBuild']),
      ...overrides,
    };
    return { calls, deps };
  }

  it('pre-selects AAB, opens the Build tab, refreshes state, then starts the build', async () => {
    const { calls, deps } = makeDeps({ choice: 'aab' });
    const started = await offerBuildAfterFixAll(deps);
    assert.strictEqual(started, true);
    assert.deepStrictEqual(calls, [
      ['choose', 'Start a build now?', 'Build'],
      ['selectArtifact', 'aab'],
      ['switchTab', 'build'],
      ['refresh'],
      ['startBuild'],
    ]);
  });

  it('pre-selects APK when that artifact is chosen', async () => {
    const { calls, deps } = makeDeps({ choice: 'apk' });
    const started = await offerBuildAfterFixAll(deps);
    assert.strictEqual(started, true);
    assert.deepStrictEqual(
      calls.filter((c) => c[0] === 'selectArtifact'),
      [['selectArtifact', 'apk']]
    );
  });

  it('offers both artifacts plus a "Not now" option', async () => {
    const { calls, deps } = makeDeps({ choice: 'none' });
    await offerBuildAfterFixAll(deps);
    const [chooseCfg] = calls;
    assert.strictEqual(chooseCfg[0], 'choose');
    // The option list itself isn't captured by the stub — assert via a direct
    // call that records the full config.
    let captured = null;
    await offerBuildAfterFixAll({
      ...deps,
      choose: async (cfg) => {
        captured = cfg;
        return 'none';
      },
    });
    assert.deepStrictEqual(
      captured.options.map((o) => o.value),
      ['aab', 'apk', 'none']
    );
    assert.strictEqual(captured.confirmText, 'Build');
  });

  it('does nothing when the user picks "Not now"', async () => {
    const { calls, deps } = makeDeps({ choice: 'none' });
    const started = await offerBuildAfterFixAll(deps);
    assert.strictEqual(started, false);
    assert.strictEqual(calls.length, 1, 'only the artifact modal should run');
    assert.strictEqual(calls[0][0], 'choose');
  });

  it('does nothing when the modal is cancelled (null)', async () => {
    const { calls, deps } = makeDeps({ choice: null });
    const started = await offerBuildAfterFixAll(deps);
    assert.strictEqual(started, false);
    assert.strictEqual(calls.length, 1);
  });
});

describe('helpers', () => {
  it('buildDefaultPackageName sanitizes and lowercases the folder', () => {
    assert.strictEqual(buildDefaultPackageName('My Cool App'), 'com.example.mycoolapp');
    assert.strictEqual(buildDefaultPackageName('My-App_V2'), 'com.example.myappv2');
    assert.strictEqual(buildDefaultPackageName('!!!'), 'com.example.app');
    assert.strictEqual(buildDefaultPackageName(''), 'com.example.app');
    assert.strictEqual(buildDefaultPackageName(null), 'com.example.app');
  });

  it('missingPartsLabel joins the missing pieces', () => {
    assert.strictEqual(missingPartsLabel(true, false), 'the Android package name');
    assert.strictEqual(missingPartsLabel(false, true), 'a release signing keystore');
    assert.strictEqual(
      missingPartsLabel(true, true),
      'the Android package name and a release signing keystore'
    );
    assert.strictEqual(missingPartsLabel(false, false), '');
  });
});

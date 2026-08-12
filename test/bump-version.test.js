/**
 * Regression tests for the version-bump fixes:
 *  - A3: bumpVersion no longer throws when android/app/build.gradle is absent
 *        (iOS-only builds previously crashed at step 2/5).
 *  - B1: non-numeric / leading-zero / pre-release patches are rejected with a
 *        clear error instead of producing 1.0.NaN or silently dropping zeros.
 *  - EAS resolution: when `eas build:version:get` output drifts to something
 *        unparseable, bumpVersion must fall back to the EAS GraphQL API (the
 *        exact query eas-cli uses) instead of settling for a local-only bump.
 *
 * Run with: npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// execa v9 is ESM-only: `require('execa')` returns a module-namespace object
// whose properties are not redefinable, so patching `execaSync` on it (the
// usual stub technique) silently no-ops and the real `eas` CLI runs. Instead
// we intercept the require itself (same pattern as doctor-fixall-eas.test.js
// for @inquirer/prompts) BEFORE dist/core/bumpVersion.js binds its import.
let easCliStub = null; // per-test behavior for `eas ...` invocations
const easCliCalls = []; // every eas invocation, { command, args }
const fakeExeca = {
  execaSync: (command, args) => {
    easCliCalls.push({ command, args });
    if (!easCliStub) throw new Error(`eas CLI stub not configured for this test: ${args.join(' ')}`);
    return easCliStub(command, args);
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'execa') return fakeExeca;
  return originalLoad.apply(this, arguments);
};

const { bumpVersion, parseEasCliVersionCode } = require('../dist/core/bumpVersion.js');
// Real CJS modules — their exports are patchable at call time.
const easApiMod = require('../dist/core/eas/api.js');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leb-bump-'));
}

function writeAppJson(dir, version) {
  fs.writeFileSync(
    path.join(dir, 'app.json'),
    JSON.stringify({ expo: { name: 'Test App', slug: 'test-app', version } }, null, 2)
  );
}

function writePkgJson(dir, version) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'test-app', version, dependencies: { expo: '52.0.0' } }, null, 2)
  );
}

describe('bumpVersion', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('bumps app.json/package.json without throwing when build.gradle is absent (iOS-only flow)', async () => {
    writeAppJson(dir, '1.2.3');
    writePkgJson(dir, '1.2.3');

    // No android/ directory at all — must not throw (A3).
    const result = await bumpVersion({ cwd: dir });

    assert.strictEqual(result.versionName, '1.2.4');
    assert.strictEqual(result.versionCode, null); // nothing to write a code into
    const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    assert.strictEqual(appJson.expo.version, '1.2.4');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '1.2.4');
    assert.ok(!fs.existsSync(path.join(dir, 'android')), 'no android/ dir should be created');
  });

  it('still writes versionCode/versionName into build.gradle when present', async () => {
    writeAppJson(dir, '1.2.3');
    const gradlePath = path.join(dir, 'android', 'app', 'build.gradle');
    fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
    fs.writeFileSync(gradlePath, [
      'android {',
      '    defaultConfig {',
      '        versionCode 5',
      '        versionName "1.2.3"',
      '    }',
      '}',
      '',
    ].join('\n'));

    const result = await bumpVersion({ cwd: dir });
    assert.strictEqual(result.versionCode, 6);
    const gradle = fs.readFileSync(gradlePath, 'utf8');
    assert.match(gradle, /versionCode 6/);
    assert.match(gradle, /versionName "1\.2\.4"/);
  });

  it('rejects a non-numeric patch instead of producing 1.0.NaN', async () => {
    writeAppJson(dir, '1.2.x');
    await assert.rejects(bumpVersion({ cwd: dir }), /Unexpected patch segment/);
  });

  it('rejects leading-zero patches instead of silently dropping the zero', async () => {
    writeAppJson(dir, '1.2.07');
    await assert.rejects(bumpVersion({ cwd: dir }), /Unexpected patch segment/);
  });

  it('rejects pre-release / build-metadata versions with a clear message', async () => {
    writeAppJson(dir, '1.2.3-rc.1');
    await assert.rejects(bumpVersion({ cwd: dir }), /not supported by the version bump/);
  });
});

describe('parseEasCliVersionCode', () => {
  it('parses the current eas-cli format (hyphen separator)', () => {
    assert.strictEqual(parseEasCliVersionCode('Android versionCode - 1\niOS buildNumber - 1\n'), 1);
  });

  it('parses en-dash and colon separators eas-cli has used historically', () => {
    assert.strictEqual(parseEasCliVersionCode('Android versionCode – 7'), 7);
    assert.strictEqual(parseEasCliVersionCode('Android versionCode: 12'), 12);
  });

  it('strips ANSI color codes before matching (FORCE_COLOR environments)', () => {
    // eas-cli wraps the value in chalk.bold when colors are forced.
    assert.strictEqual(parseEasCliVersionCode('Android versionCode - \u001b[1m3\u001b[22m'), 3);
  });

  it('falls through to a bare versionCode line', () => {
    assert.strictEqual(parseEasCliVersionCode('versionCode: 42'), 42);
  });

  it('returns null when nothing parseable is present', () => {
    assert.strictEqual(parseEasCliVersionCode(''), null);
    assert.strictEqual(parseEasCliVersionCode('No remote versions are configured for this project.'), null);
    assert.strictEqual(parseEasCliVersionCode('iOS buildNumber - 5'), null);
  });
});

describe('bumpVersion EAS versionCode resolution fallbacks', () => {
  // eas CLI invocations go through the Module._load-intercepted fakeExeca
  // (see the top of this file); `easGraphql`/`resolveEasAuth` live in the real
  // CJS eas/api module and are patched on it directly.
  let dir;
  let graphqlCalls;
  let origEasGraphql;
  let origResolveAuth;

  function tmpEasProject() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-bump-eas-'));
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ name: 'eas-app', version: '1.2.3', dependencies: { expo: '52.0.0' } }, null, 2)
    );
    fs.writeFileSync(
      path.join(d, 'app.json'),
      JSON.stringify(
        {
          expo: {
            name: 'Eas App',
            slug: 'eas-app',
            version: '1.2.3',
            android: { package: 'com.example.easapp' },
            extra: { eas: { projectId: '00000000-0000-0000-0000-000000000000' } },
          },
        },
        null,
        2
      )
    );
    // EAS remote versioning must be on or the whole EAS section is skipped.
    fs.writeFileSync(path.join(d, 'eas.json'), JSON.stringify({ cli: { appVersionSource: 'remote' } }, null, 2));
    const gradlePath = path.join(d, 'android', 'app', 'build.gradle');
    fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
    fs.writeFileSync(gradlePath, ['android {', '    defaultConfig {', '        versionCode 5', '        versionName "1.2.3"', '    }', '}', ''].join('\n'));
    return d;
  }

  beforeEach(() => {
    dir = tmpEasProject();
    graphqlCalls = [];
    easCliCalls.length = 0;
    origEasGraphql = easApiMod.easGraphql;
    origResolveAuth = easApiMod.resolveEasAuth;
  });

  afterEach(() => {
    easCliStub = null;
    easApiMod.easGraphql = origEasGraphql;
    easApiMod.resolveEasAuth = origResolveAuth;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('uses the GraphQL API when `eas build:version:get` output drifts (regression)', async () => {
    easCliStub = (cmd, args) => {
      if (args[0] === 'build:version:get') {
        // Simulate a future eas-cli release that changes its text output
        // shape — exit 0 (command succeeded) but nothing parseable.
        return { exitCode: 0, stdout: '  version: 1.2.3 (some brand new layout)  ' };
      }
      throw new Error(`unexpected eas invocation: ${args.join(' ')}`);
    };
    easApiMod.resolveEasAuth = () => ({ token: 'fake-token' });
    easApiMod.easGraphql = async (query, variables) => {
      graphqlCalls.push({ query, variables });
      return {
        app: {
          byId: {
            latestAppVersionByPlatformAndApplicationIdentifier: { buildVersion: '7' },
          },
        },
      };
    };

    const result = await bumpVersion({ cwd: dir });

    // 7 (remote, via GraphQL) + 1 = 8 — NOT the local gradle 5 + 1 = 6.
    assert.strictEqual(result.versionCode, 8, 'must bump from the GraphQL buildVersion');
    const gradle = fs.readFileSync(path.join(dir, 'android', 'app', 'build.gradle'), 'utf8');
    assert.match(gradle, /versionCode 8/);
    assert.match(gradle, /versionName "1\.2\.4"/);

    assert.strictEqual(graphqlCalls.length, 1, 'GraphQL fallback must run exactly once');
    assert.strictEqual(graphqlCalls[0].variables.platform, 'ANDROID');
    assert.strictEqual(graphqlCalls[0].variables.applicationIdentifier, 'com.example.easapp');
    assert.strictEqual(graphqlCalls[0].variables.appId, '00000000-0000-0000-0000-000000000000');
    // The seed path must NOT run: the CLI exited 0 (no "first build" signal).
    assert.ok(
      !easCliCalls.some(({ args }) => args[0] === 'build:version:set'),
      'build:version:set (seed) must not run when get exited 0'
    );
  });

  it('falls back to a local bump when the GraphQL fallback has no auth', async () => {
    easCliStub = (cmd, args) => {
      if (args[0] === 'build:version:get') {
        return { exitCode: 0, stdout: 'unparseable output' };
      }
      throw new Error(`unexpected eas invocation: ${args.join(' ')}`);
    };
    easApiMod.resolveEasAuth = () => null; // no EXPO_TOKEN, no eas login session

    const result = await bumpVersion({ cwd: dir });

    assert.strictEqual(result.versionCode, 6, 'local gradle 5 + 1');
    assert.strictEqual(graphqlCalls.length, 0, 'GraphQL must not be called without auth');
    assert.ok(
      !easCliCalls.some(({ args }) => args[0] === 'build:version:set'),
      'seed must not run when get exited 0'
    );
  });

  it('does not call the GraphQL API when the CLI parses cleanly (happy path)', async () => {
    easCliStub = (cmd, args) => {
      if (args[0] === 'build:version:get') {
        return { exitCode: 0, stdout: 'Android versionCode - 3' };
      }
      throw new Error(`unexpected eas invocation: ${args.join(' ')}`);
    };
    easApiMod.resolveEasAuth = () => ({ token: 'fake-token' });

    const result = await bumpVersion({ cwd: dir });

    assert.strictEqual(result.versionCode, 4, '3 (CLI) + 1');
    assert.strictEqual(graphqlCalls.length, 0, 'GraphQL must not run when the CLI parse succeeds');
  });
});

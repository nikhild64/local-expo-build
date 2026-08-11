/**
 * Unit tests for the `build android` pre-flight (P0-2), exercised in-process
 * through the exported functions in dist/commands/build.js — no TTY required.
 *
 * Coverage:
 *  - analyzeAndroidPreflight: the file-based checks (Android package from
 *    app.json, release keystore from keystore.properties) and the debug-skip.
 *  - applyAndroidPreflightFixes: which fixes run (injectable fixers), the
 *    smart package default, and error isolation.
 *  - preflightAndroidBuild: the full decision flow — non-TTY / --dry-run
 *    no-ops, confirm gating, and what happens on accept / decline.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyzeAndroidPreflight,
  applyAndroidPreflightFixes,
  preflightAndroidBuild,
} = require('../dist/commands/build.js');

const VALID_PROPS =
  'storeFile=release.p12\n' +
  'storePassword=secret123\n' +
  'keyAlias=release\n' +
  'keyPassword=secret123\n';

/**
 * Creates a temp Expo-like project. `packageName` writes expo.android.package
 * into app.json; `keystore` writes a valid keystore.properties.
 */
function fakeProject({ packageName, keystore = false, extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-preflight-'));
  const appJson = {
    expo: {
      name: 'Preflight App',
      slug: 'preflight-app',
      version: '1.0.0',
      ...(extra || {}),
    },
  };
  if (packageName) {
    appJson.expo.android = { package: packageName };
  }
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify(appJson, null, 2) + '\n', 'utf8');
  if (keystore) {
    fs.writeFileSync(path.join(dir, 'keystore.properties'), VALID_PROPS, 'utf8');
  }
  return dir;
}

/** Restores process.stdin.isTTY after a test that fakes it. */
function withTTY(value, fn) {
  const original = process.stdin.isTTY;
  process.stdin.isTTY = value;
  try {
    return fn();
  } finally {
    process.stdin.isTTY = original;
  }
}

describe('analyzeAndroidPreflight (file-based checks)', () => {
  it('flags a missing package and missing keystore together', () => {
    const dir = fakeProject({});
    try {
      const a = analyzeAndroidPreflight(dir, { debug: false });
      assert.strictEqual(a.needsPackage, true);
      assert.strictEqual(a.needsKeystore, true);
      assert.strictEqual(
        a.missing,
        'the Android package (expo.android.package) and a release signing keystore'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags only the keystore when the package is present', () => {
    const dir = fakeProject({ packageName: 'com.example.myapp' });
    try {
      const a = analyzeAndroidPreflight(dir, { debug: false });
      assert.strictEqual(a.needsPackage, false);
      assert.strictEqual(a.needsKeystore, true);
      assert.strictEqual(a.missing, 'a release signing keystore');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags only the package when the keystore is configured', () => {
    const dir = fakeProject({ keystore: true });
    try {
      const a = analyzeAndroidPreflight(dir, { debug: false });
      assert.strictEqual(a.needsPackage, true);
      assert.strictEqual(a.needsKeystore, false);
      assert.strictEqual(a.missing, 'the Android package (expo.android.package)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a ready project', () => {
    const dir = fakeProject({ packageName: 'com.example.myapp', keystore: true });
    try {
      const a = analyzeAndroidPreflight(dir, { debug: false });
      assert.strictEqual(a.needsPackage, false);
      assert.strictEqual(a.needsKeystore, false);
      assert.strictEqual(a.missing, '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the keystore check for debug builds', () => {
    const dir = fakeProject({ packageName: 'com.example.myapp' });
    try {
      const a = analyzeAndroidPreflight(dir, { debug: true });
      assert.strictEqual(a.needsPackage, false);
      assert.strictEqual(a.needsKeystore, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a syntactically invalid package as present (doctor validates it)', () => {
    const dir = fakeProject({ packageName: 'BadPackageName' });
    try {
      const a = analyzeAndroidPreflight(dir, { debug: false });
      // Analysis only gates on *missing* — an invalid value is doctor's job.
      assert.strictEqual(a.needsPackage, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never auto-fixes a dynamic-only project (no app.json)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-preflight-dyn-'));
    try {
      // app.config.* (no app.json) — the pre-flight only auto-fixes the
      // static app.json source; dynamic configs are doctor's job.
      fs.writeFileSync(path.join(dir, 'app.config.js'), 'module.exports = {};', 'utf8');
      const a = analyzeAndroidPreflight(dir, { debug: false });
      assert.strictEqual(a.needsPackage, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyAndroidPreflightFixes (fix decision)', () => {
  it('writes the smart package default and re-analysis reflects it', async () => {
    const dir = fakeProject({});
    try {
      const analysis = analyzeAndroidPreflight(dir, { debug: false });
      // Keep the real setAndroidPackage (so app.json + cache invalidation are
      // exercised); stub setupKeystore — the real default is the shared
      // auto-setup chain (keytool / EAS network), which the test avoids.
      await applyAndroidPreflightFixes(dir, analysis, {
        setupKeystore: async () => {},
      });

      const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
      // Smart default derives from the folder name, sanitized to [a-z0-9]
      // (com.example.<folder>) — hyphens from mkdtemp are stripped.
      assert.match(appJson.expo.android.package, /^com\.example\.lebpreflight\w+$/);
      // setAndroidPackage invalidates the config cache, so re-analysis sees it.
      const after = analyzeAndroidPreflight(dir, { debug: false });
      assert.strictEqual(after.needsPackage, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('calls the injected fixers for each missing piece', async () => {
    const dir = fakeProject({});
    const called = [];
    const fixers = {
      setAndroidPackage: (cwd, name) => {
        called.push(['setPackage', cwd, name]);
      },
      setupKeystore: async (cwd) => {
        called.push(['setupKeystore', cwd]);
      },
    };
    try {
      await applyAndroidPreflightFixes(dir, { needsPackage: true, needsKeystore: true }, fixers);
      assert.strictEqual(called.length, 2);
      assert.strictEqual(called[0][0], 'setPackage');
      assert.strictEqual(called[0][1], dir);
      assert.match(called[0][2], /^com\.example\./);
      assert.deepStrictEqual(called[1], ['setupKeystore', dir]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs only the fixers that are needed', async () => {
    const dir = fakeProject({});
    const called = [];
    const fixers = {
      setAndroidPackage: () => called.push('setPackage'),
      setupKeystore: async () => called.push('setupKeystore'),
    };
    try {
      await applyAndroidPreflightFixes(dir, { needsPackage: false, needsKeystore: true }, fixers);
      assert.deepStrictEqual(called, ['setupKeystore']);

      called.length = 0;
      await applyAndroidPreflightFixes(dir, { needsPackage: true, needsKeystore: false }, fixers);
      assert.deepStrictEqual(called, ['setPackage']);

      called.length = 0;
      await applyAndroidPreflightFixes(dir, { needsPackage: false, needsKeystore: false }, fixers);
      assert.deepStrictEqual(called, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isolates a throwing fixer so the other fix still runs', async () => {
    const dir = fakeProject({});
    const called = [];
    const fixers = {
      setAndroidPackage: () => {
        throw new Error('boom');
      },
      setupKeystore: async () => {
        called.push('setupKeystore');
      },
    };
    try {
      await applyAndroidPreflightFixes(dir, { needsPackage: true, needsKeystore: true }, fixers);
      assert.deepStrictEqual(called, ['setupKeystore']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('preflightAndroidBuild (full decision flow)', () => {
  it('is a no-op without a TTY — no confirm, no fixes', async () => {
    const dir = fakeProject({});
    const called = [];
    try {
      await withTTY(false, () =>
        preflightAndroidBuild(dir, { dryRun: false, debug: false }, {
          confirm: async (msg) => {
            called.push(msg);
            return true;
          },
          fixers: { setAndroidPackage: () => called.push('setPackage') },
        })
      );
      assert.deepStrictEqual(called, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op with --dry-run even on a TTY', async () => {
    const dir = fakeProject({});
    const called = [];
    try {
      await withTTY(true, () =>
        preflightAndroidBuild(dir, { dryRun: true, debug: false }, {
          confirm: async (msg) => {
            called.push(msg);
            return true;
          },
          fixers: { setAndroidPackage: () => called.push('setPackage') },
        })
      );
      assert.deepStrictEqual(called, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not prompt a ready project', async () => {
    const dir = fakeProject({ packageName: 'com.example.myapp', keystore: true });
    const called = [];
    try {
      await withTTY(true, () =>
        preflightAndroidBuild(dir, { dryRun: false, debug: false }, {
          confirm: async (msg) => {
            called.push(msg);
            return true;
          },
          fixers: { setAndroidPackage: () => called.push('setPackage') },
        })
      );
      assert.deepStrictEqual(called, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prompts with the missing pieces and applies the fixes when accepted', async () => {
    const dir = fakeProject({});
    const seen = [];
    const fixed = [];
    try {
      await withTTY(true, () =>
        preflightAndroidBuild(dir, { dryRun: false, debug: false }, {
          confirm: async (msg) => {
            seen.push(msg);
            return true;
          },
          fixers: {
            setAndroidPackage: (cwd, name) => fixed.push(['setPackage', name]),
            setupKeystore: async (cwd) => fixed.push(['setupKeystore']),
          },
        })
      );
      assert.strictEqual(seen.length, 1);
      assert.match(
        seen[0],
        /missing the Android package \(expo\.android\.package\) and a release signing keystore/
      );
      assert.strictEqual(fixed.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies no fixes when the user declines', async () => {
    const dir = fakeProject({});
    const fixed = [];
    try {
      await withTTY(true, () =>
        preflightAndroidBuild(dir, { dryRun: false, debug: false }, {
          confirm: async () => false,
          fixers: {
            setAndroidPackage: () => fixed.push('setPackage'),
            setupKeystore: async () => fixed.push('setupKeystore'),
          },
        })
      );
      assert.deepStrictEqual(fixed, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not prompt a debug build missing only the keystore', async () => {
    const dir = fakeProject({ packageName: 'com.example.myapp' });
    const called = [];
    try {
      await withTTY(true, () =>
        preflightAndroidBuild(dir, { dryRun: false, debug: true }, {
          confirm: async (msg) => {
            called.push(msg);
            return true;
          },
          fixers: { setAndroidPackage: () => called.push('setPackage') },
        })
      );
      assert.deepStrictEqual(called, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

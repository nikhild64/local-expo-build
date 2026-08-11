const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { collectDoctorChecks, setAndroidPackage, runDoctor } = require('../dist/commands/doctor.js');
const { runAndroidBuild } = require('../dist/core/androidBuild.js');
const { writeProjectIdToAppJson } = require('../dist/core/eas/link.js');
const { startUiServer } = require('../dist/server/server.js');

// Each server instance gets its own random port: undici's global agent pools
// keep-alive connections per origin, so reusing a fixed port across tests makes
// a fresh server inherit a stale pooled connection and fail with ECONNRESET.
async function randomPort() {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-ui-test-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      version: '1.0.0',
      dependencies: { expo: '52.0.0' },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'app.json'),
    JSON.stringify({
      expo: {
        name: 'Test App',
        slug: 'test-app',
        version: '1.0.0',
        android: {
          package: 'com.example.testapp',
        },
      },
    }, null, 2)
  );
  return dir;
}

describe('Doctor API & setAndroidPackage', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('collectDoctorChecks returns valid check results and capabilities', async () => {
    const summary = await collectDoctorChecks(dir);
    assert.ok(Array.isArray(summary.results));
    assert.ok(summary.capabilities);
    assert.strictEqual(typeof summary.capabilities.canFixAndroidPackage, 'boolean');
    assert.strictEqual(typeof summary.capabilities.easReady, 'boolean');
  });

  it('setAndroidPackage updates app.json with valid package name', () => {
    setAndroidPackage(dir, 'com.company.newapp');
    const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    assert.strictEqual(appJson.expo.android.package, 'com.company.newapp');
  });

  it('setAndroidPackage throws on invalid package name', () => {
    assert.throws(() => {
      setAndroidPackage(dir, 'invalidpackage');
    }, /not a valid Android applicationId/);
  });
});

describe('AndroidBuild fail-fast on missing keystore', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('runAndroidBuild throws when ensureKeystoreMode is required-existing and keystore.properties missing', async () => {
    await assert.rejects(async () => {
      await runAndroidBuild({
        cwd: dir,
        prebuild: false,
        bump: false,
        ensureKeystoreMode: 'required-existing',
      });
    }, /Signing keystore not configured/);
  });

  it('runAndroidBuild completes in dryRun mode', async () => {
    const res = await runAndroidBuild({
      cwd: dir,
      dryRun: true,
    });
    assert.strictEqual(res.kind, 'AAB');
  });

  it('runAndroidBuild debug mode in dryRun produces an APK without a keystore', async () => {
    const res = await runAndroidBuild({
      cwd: dir,
      dryRun: true,
      debug: true,
    });
    assert.strictEqual(res.kind, 'APK');
  });
});

describe('EAS project linking', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('writeProjectIdToAppJson preserves sibling Expo keys', () => {
    writeProjectIdToAppJson(dir, 'project-id');
    const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    assert.strictEqual(appJson.expo.name, 'Test App');
    assert.strictEqual(appJson.expo.android.package, 'com.example.testapp');
    assert.strictEqual(appJson.expo.extra.eas.projectId, 'project-id');
  });
});

describe('UI HTTP Server REST endpoints', () => {
  let dir;
  let serverInstance;

  beforeEach(async () => {
    dir = tmpProject();
    serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false });
  });

  afterEach(async () => {
    if (serverInstance) await serverInstance.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('serves GET /api/status', async () => {
    const res = await fetch(`${serverInstance.url}/api/status`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.cwd, dir);
    assert.strictEqual(data.buildStatus, 'idle');
  });

  it('serves GET /api/doctor', async () => {
    const res = await fetch(`${serverInstance.url}/api/doctor`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.results));
  });

  it('serves GET /api/eas/auth with a stable unauthenticated shape', async () => {
    const res = await fetch(`${serverInstance.url}/api/eas/auth`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.authenticated, 'boolean');
  });

  it('injects appVersionSource remote into an existing eas.json without invoking EAS CLI', async () => {
    const easPath = path.join(dir, 'eas.json');
    const initial = '{\n  "build": { "production": {} }\n}\n';
    fs.writeFileSync(easPath, initial);
    const response = await fetch(`${serverInstance.url}/api/eas/configure`, { method: 'POST' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).created, false);
    const updated = JSON.parse(fs.readFileSync(easPath, 'utf8'));
    assert.strictEqual(updated.cli.appVersionSource, 'remote');
    assert.deepStrictEqual(updated.build, { production: {} });
  });

  it('rejects EAS linking without a project selection', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${serverInstance.url}/api/eas/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '2', Connection: 'close' },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.strictEqual(status, 400);
  });

  it('rejects EAS keystore fetch before network access when unlinked', async () => {
    const res = await fetch(`${serverInstance.url}/api/keystore/fetch-eas`, { method: 'POST' });
    assert.strictEqual(res.status, 409);
    assert.match((await res.json()).error, /not linked to EAS/i);
  });

  it('serves GET /api/keystore/status', async () => {
    const res = await fetch(`${serverInstance.url}/api/keystore/status`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.configured, false);
  });

  it('redacts keystore passwords from status endpoints (B3)', async () => {
    // Configure a keystore so the endpoints have props to expose.
    fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'android', 'app', 'release.jks'), 'fake');
    fs.writeFileSync(
      path.join(dir, 'keystore.properties'),
      ['storeFile=release.jks', 'storePassword=sp123', 'keyAlias=release', 'keyPassword=kp123'].join('\n')
    );

    const status = await (await fetch(`${serverInstance.url}/api/status`)).json();
    assert.ok(status.keystoreProps);
    assert.strictEqual(status.keystoreProps.storeFile, 'release.jks');
    assert.ok(!('storePassword' in status.keystoreProps), 'storePassword must be redacted');
    assert.ok(!('keyPassword' in status.keystoreProps), 'keyPassword must be redacted');

    const ks = await (await fetch(`${serverInstance.url}/api/keystore/status`)).json();
    assert.ok(ks.props);
    assert.strictEqual(ks.props.storeFile, 'release.jks');
    assert.ok(!('storePassword' in ks.props), 'storePassword must be redacted');
    assert.ok(!('keyPassword' in ks.props), 'keyPassword must be redacted');
  });

  it('accepts a .p12 keystore upload and registers it under the original filename (B11/B12/A5)', async () => {
    // Build the multipart body explicitly (deterministic bytes) instead of
    // relying on undici's FormData encoding.
    const boundary = '----regression-test-boundary';
    const body = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="jks"; filename="release.p12"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n' +
        'fake-p12-content\r\n' +
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="keyAlias"\r\n\r\n' +
        'release\r\n' +
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="storePassword"\r\n\r\n' +
        'sp123\r\n' +
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="keyPassword"\r\n\r\n' +
        'sp123\r\n' +
        `--${boundary}--\r\n`,
      'utf8'
    );

    const res = await fetch(`${serverInstance.url}/api/keystore/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    assert.strictEqual(res.status, 200, await res.text());

    // B12: registered under the original filename, not the temp upload name
    const props = fs.readFileSync(path.join(dir, 'keystore.properties'), 'utf8');
    assert.match(props, /storeFile=release\.p12/);
    assert.ok(fs.existsSync(path.join(dir, 'android', 'app', 'release.p12')), 'keystore copied to android/app');

    // credentials.json mirrors the same path
    const cred = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
    assert.strictEqual(cred.android.keystore.keystorePath, 'android/app/release.p12');

    // A5: secrets are gitignored after a UI-driven import
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    for (const entry of ['keystore.properties', '*.jks', '*.p12', 'credentials.json']) {
      assert.ok(gi.includes(entry), `.gitignore should contain "${entry}"`);
    }
  });
});

describe('UI server shutdown and mid-build keystore locks (B4/B10)', () => {
  let dir;
  let serverInstance;

  beforeEach(async () => {
    dir = tmpProject();
    // Fake android/ with sleeping gradle wrappers so a debug build stays
    // "active" long enough to exercise the guards deterministically.
    const androidDir = path.join(dir, 'android');
    fs.mkdirSync(androidDir, { recursive: true });
    fs.writeFileSync(path.join(androidDir, 'gradlew'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 });
    fs.writeFileSync(path.join(androidDir, 'gradlew.bat'), '@echo off\r\nping -n 4 127.0.0.1 >nul\r\n');
    serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false });
  });

  afterEach(async () => {
    if (serverInstance) await serverInstance.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function startSleepingBuild() {
    return fetch(`${serverInstance.url}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ debug: true, prebuild: false, bump: false, sync: false }),
    });
  }

  it('rejects keystore mutations with 409 while a build is running, then releases (B10)', async () => {
    const start = await startSleepingBuild();
    assert.strictEqual(start.status, 202);

    const guarded = ['/api/keystore/setup', '/api/keystore/upload', '/api/doctor/rehydrate'];
    for (const p of guarded) {
      const res = await fetch(`${serverInstance.url}${p}`, { method: 'POST' });
      assert.strictEqual(res.status, 409, `${p} should 409 while building`);
    }

    // Wait for the fake gradle run to finish, then the guards must be released.
    await new Promise((r) => setTimeout(r, 4000));
    for (const p of guarded) {
      const res = await fetch(`${serverInstance.url}${p}`, { method: 'POST' });
      assert.notStrictEqual(res.status, 409, `${p} should not 409 after the build`);
    }
  });

  it('server close() aborts an in-flight build and resolves (B4)', async () => {
    const start = await startSleepingBuild();
    assert.strictEqual(start.status, 202);

    // Closing while the build is active must abort it and resolve cleanly.
    await serverInstance.close();
    serverInstance = null;
  });
});

describe('doctor --fix row replacement (A2)', () => {
  it('replaces the Android package row instead of appending a stale one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-doctor-fix-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fix-app', version: '1.0.0', dependencies: { expo: '52.0.0' } }, null, 2)
    );
    // No expo.android.package on purpose.
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify({ expo: { name: 'Fix App', slug: 'fix-app', version: '1.0.0' } }, null, 2)
    );
    // Configure a keystore so the fix-all path does not try to run keytool.
    fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'android', 'app', 'release.jks'), 'fake');
    fs.writeFileSync(
      path.join(dir, 'keystore.properties'),
      ['storeFile=release.jks', 'storePassword=sp123', 'keyAlias=release', 'keyPassword=kp123'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        android: { keystore: { keystorePath: 'android/app/release.jks', keystorePassword: 'sp123', keyAlias: 'release', keyPassword: 'kp123' } },
      }, null, 2)
    );

    try {
      const { results } = await runDoctor({ cwd: dir, dryRun: false, fixAll: true, skipUpdateCheck: true });

      const pkgRows = results.filter((r) => r.name === 'Android package (app.json)');
      assert.strictEqual(pkgRows.length, 1, 'should be exactly one package row after the fix');
      assert.strictEqual(pkgRows[0].ok, true);
      assert.match(pkgRows[0].detail, /^com\.example\./);

      // The old stale row name must not linger (and no duplicate may be appended).
      assert.ok(
        !results.some((r) => r.name === 'Android package (applicationId)'),
        'no stale-named row should remain'
      );

      const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
      assert.match(appJson.expo.android.package, /^com\.example\./);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('doctor --fix respects --dry-run (D2)', () => {
  it('applies no fixes under dry-run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-doctor-dry-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'dry-app', version: '1.0.0', dependencies: { expo: '52.0.0' } }, null, 2)
    );
    // No expo.android.package and no keystore — both would be "fixed" if
    // --fix ran for real.
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify({ expo: { name: 'Dry App', slug: 'dry-app', version: '1.0.0' } }, null, 2)
    );

    try {
      const { results } = await runDoctor({ cwd: dir, dryRun: true, fixAll: true, skipUpdateCheck: true });

      // app.json untouched — no android.package added
      const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
      assert.strictEqual(
        appJson.expo.android,
        undefined,
        'dry-run must not write expo.android.package'
      );

      // No keystore generated / written
      assert.ok(!fs.existsSync(path.join(dir, 'keystore.properties')), 'dry-run must not write keystore.properties');
      assert.ok(!fs.existsSync(path.join(dir, 'credentials.json')), 'dry-run must not write credentials.json');

      // The check rows are still reported honestly
      assert.ok(
        results.some((r) => r.name === 'Android package (app.json)' && !r.ok),
        'the missing-package row should still be reported as failing'
      );
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

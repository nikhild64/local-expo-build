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
const { startUiServer, listenWithRetry, redactLogLine } = require('../dist/server/server.js');

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
    // quiet: server startup logs interleave with node:test's stdout protocol on
    // Windows and intermittently corrupt the runner stream ("Unable to
    // deserialize cloned data").
    serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false, quiet: true });
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

  it('POST /api/keystore/auto-setup runs the shared chain (rehydrate path)', async () => {
    // A real rehydrate candidate (credentials.json + .jks) — the chain must
    // pick rehydrate without keytool or any EAS network call.
    const jksDir = path.join(dir, 'credentials', 'android');
    fs.mkdirSync(jksDir, { recursive: true });
    fs.writeFileSync(path.join(jksDir, 'release.jks'), 'fake-keystore-bytes');
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        android: {
          keystore: {
            keystorePath: 'credentials/android/release.jks',
            keystorePassword: 'sp123456',
            keyAlias: 'release',
            keyPassword: 'kp123456',
          },
        },
      }, null, 2)
    );

    const res = await fetch(`${serverInstance.url}/api/keystore/auto-setup`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.provider, 'rehydrate');
    assert.strictEqual(data.storeFile, 'release.jks');
    // Generated passwords are only returned for local generation.
    assert.strictEqual(data.generatedPassword, undefined);
    assert.ok(fs.existsSync(path.join(dir, 'keystore.properties')), 'keystore.properties written');
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

describe('keystore upload filename sanitization (D8)', () => {
  let dir;
  let serverInstance;

  beforeEach(async () => {
    dir = tmpProject();
    serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false, quiet: true });
  });

  afterEach(async () => {
    if (serverInstance) await serverInstance.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('sanitizes hostile filenames so storeFile can never break Gradle injection', async () => {
    const boundary = '----regression-test-boundary';
    const body = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="jks"; filename="my key's (2).jks"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n' +
        'fake-p12-content\r\n' +
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="keyAlias"\r\n\r\n' +
        'release\r\n' +
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="storePassword"\r\n\r\n' +
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

    // The quote/space/paren chars are replaced with underscores; nothing
    // that could break file('...') survives.
    const props = fs.readFileSync(path.join(dir, 'keystore.properties'), 'utf8');
    const storeFileLine = props.split('\n').find((l) => l.startsWith('storeFile='));
    assert.strictEqual(storeFileLine, 'storeFile=my_key_s__2_.jks');
    assert.match(storeFileLine, /^storeFile=[A-Za-z0-9._-]+$/, 'storeFile must be restricted to a safe charset');
    assert.ok(
      fs.existsSync(path.join(dir, 'android', 'app', 'my_key_s__2_.jks')),
      'keystore copied under the sanitized name'
    );
  });
});

describe('keystore upload temp cleanup on abort (D5)', () => {
  it('removes the temp upload file when the client disconnects mid-upload', async () => {
    const dir = tmpProject();
    const serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false, quiet: true });
    const filename = `abort-${Date.now()}-${Math.random().toString(36).slice(2)}.jks`;
    const boundary = '----abort-boundary';
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="jks"; filename="${filename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n' +
        'x'.repeat(512 * 1024),
      'utf8'
    );

    try {
      await new Promise((resolve) => {
        const req = http.request(`${serverInstance.url}/api/keystore/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            // Advertise much more than we send so the server keeps reading.
            'Content-Length': prefix.length + 64 * 1024 * 1024,
            Connection: 'close',
          },
        });
        req.on('error', resolve);
        req.on('close', resolve);
        req.write(prefix);
        // Give the server a tick to open the temp write stream, then abort.
        setTimeout(() => req.destroy(), 100);
      });

      // The temp file (upload-<ts>-<filename> in os.tmpdir()) must be cleaned
      // up — poll briefly to allow the cleanup to run.
      let leftover = null;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const matches = fs.readdirSync(os.tmpdir()).filter((f) => f.includes(filename));
        if (matches.length === 0) {
          leftover = null;
          break;
        }
        leftover = matches;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.strictEqual(leftover, null, `temp upload file left behind: ${leftover}`);
    } finally {
      await serverInstance.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
    serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false, quiet: true });
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

    const guarded = ['/api/keystore/setup', '/api/keystore/upload', '/api/keystore/auto-setup'];
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

describe('keystore mutation mutex (D9)', () => {
  it('rejects a second keystore mutation while another is in flight, then releases', async () => {
    const dir = tmpProject();
    const serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false, quiet: true });
    try {
      // A multipart upload whose body never arrives holds the operation mutex
      // for as long as we keep the socket open.
      const req = http.request(`${serverInstance.url}/api/keystore/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=----hold',
          'Content-Length': 1024 * 1024 * 1024,
          Connection: 'close',
        },
      });
      req.on('error', () => {});
      req.end();

      // Give the server time to enter the upload route and acquire the mutex.
      await new Promise((r) => setTimeout(r, 200));

      const blocked = await fetch(`${serverInstance.url}/api/keystore/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'import', params: {} }),
      });
      assert.strictEqual(blocked.status, 409, 'second mutation should 409 while the first holds the mutex');

      // Close the stuck upload → the mutex must be released.
      req.destroy();
      await new Promise((r) => setTimeout(r, 300));

      // Now the same setup call runs (and fails with its own error, not 409).
      const after = await fetch(`${serverInstance.url}/api/keystore/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'import', params: {} }),
      });
      assert.notStrictEqual(after.status, 409, 'mutex should be released after the upload settles');
    } finally {
      await serverInstance.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
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

describe('static file serving (D10)', () => {
  it('serves index.html for missing paths instead of crashing', async () => {
    const dir = tmpProject();
    const serverInstance = await startUiServer({ cwd: dir, port: await randomPort(), openBrowser: false, quiet: true });
    try {
      // The read-error handler itself (file vanishing between existsSync and
      // open) can't be triggered deterministically; this exercises the static
      // path end-to-end and the SPA fallback.
      const res = await fetch(`${serverInstance.url}/does-not-exist-xyz.js`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.match(text, /<html/i, 'missing paths should fall back to index.html');
    } finally {
      await serverInstance.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('UI server bind retry (D4)', () => {
  it('binds to the next free port when the preferred port is taken', async () => {
    const occupied = net.createServer();
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const takenPort = occupied.address().port;

    const dir = tmpProject();
    let instance;
    try {
      instance = await startUiServer({ cwd: dir, port: takenPort, openBrowser: false, quiet: true });
      assert.ok(instance.port > takenPort, `expected a port above ${takenPort}, got ${instance.port}`);

      // The server is fully functional on the retried port.
      const res = await fetch(`${instance.url}/api/status`);
      assert.strictEqual(res.status, 200);
    } finally {
      if (instance) await instance.close();
      await new Promise((resolve) => occupied.close(resolve));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('listenWithRetry rejects cleanly when the port range is exhausted', async () => {
    const occupied = net.createServer();
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const takenPort = occupied.address().port;
    const server = http.createServer();
    try {
      // maxAttempts=1 means only `takenPort` is tried → EADDRINUSE → throw.
      await assert.rejects(
        () => listenWithRetry(server, takenPort, 1),
        /Could not bind the UI server/
      );
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
  });
});

describe('redactLogLine (D12)', () => {
  it('redacts key=value and key: value forms', () => {
    const out = redactLogLine('-PstorePassword=hunter2');
    assert.ok(out.includes('storePassword=[REDACTED]'));
    assert.ok(!out.includes('hunter2'));
  });

  it('redacts quoted values containing spaces', () => {
    const out = redactLogLine('password: "my pass 123"');
    assert.ok(out.includes('password=[REDACTED]'));
    assert.ok(!out.includes('my pass'), 'quoted value with spaces must be fully redacted');
  });

  it('redacts bare space-separated values', () => {
    const out = redactLogLine('storePassword android keyAlias release');
    assert.ok(out.includes('storePassword=[REDACTED]'), 'space-separated value must be redacted');
    assert.ok(!out.includes('storePassword android'));
  });

  it('redacts keyPassword/storePassword specifically', () => {
    const out = redactLogLine('keyPassword=secret storePassword=also-secret');
    assert.ok(!out.includes('secret'));
    assert.ok(!out.includes('also-secret'));
  });

  it('redacts long base64 blobs', () => {
    const blob = 'A'.repeat(600);
    assert.strictEqual(redactLogLine(blob), '[REDACTED_BASE64]');
  });

  it('leaves ordinary build lines intact', () => {
    const line = '> Task :app:assembleRelease UP-TO-DATE';
    assert.strictEqual(redactLogLine(line), line);
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

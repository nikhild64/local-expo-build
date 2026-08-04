const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { collectDoctorChecks, setAndroidPackage } = require('../dist/commands/doctor.js');
const { runAndroidBuild } = require('../dist/core/androidBuild.js');
const { writeProjectIdToAppJson } = require('../dist/core/eas/link.js');
const { startUiServer } = require('../dist/server/server.js');

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
    serverInstance = await startUiServer({ cwd: dir, port: 3999, openBrowser: false });
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

  it('leaves an existing eas.json unchanged without invoking EAS CLI', async () => {
    const easPath = path.join(dir, 'eas.json');
    const initial = '{\n  "build": { "production": {} }\n}\n';
    fs.writeFileSync(easPath, initial);
    const response = await fetch(`${serverInstance.url}/api/eas/configure`, { method: 'POST' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).created, false);
    assert.strictEqual(fs.readFileSync(easPath, 'utf8'), initial);
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
});

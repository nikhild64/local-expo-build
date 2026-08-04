const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { collectDoctorChecks, setAndroidPackage } = require('../dist/commands/doctor.js');
const { runAndroidBuild } = require('../dist/core/androidBuild.js');
const { ALLOWLISTED_COMMANDS, PtyManager } = require('../dist/server/ptyServer.js');
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
});

describe('PTY Command Allowlist', () => {
  it('allowlists only specific eas commands', () => {
    assert.ok(ALLOWLISTED_COMMANDS['eas-init']);
    assert.ok(ALLOWLISTED_COMMANDS['eas-configure']);
    assert.ok(ALLOWLISTED_COMMANDS['eas-credentials']);
    assert.strictEqual(Object.keys(ALLOWLISTED_COMMANDS).length, 3);
    assert.strictEqual(ALLOWLISTED_COMMANDS['rm-rf'], undefined);
  });

  it('PtyManager detects availability gracefully', () => {
    const mgr = new PtyManager();
    assert.strictEqual(typeof mgr.isPtyAvailable(), 'boolean');
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

  it('serves GET /api/keystore/status', async () => {
    const res = await fetch(`${serverInstance.url}/api/keystore/status`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.configured, false);
  });
});

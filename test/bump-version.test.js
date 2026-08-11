/**
 * Regression tests for the version-bump fixes:
 *  - A3: bumpVersion no longer throws when android/app/build.gradle is absent
 *        (iOS-only builds previously crashed at step 2/5).
 *  - B1: non-numeric / leading-zero / pre-release patches are rejected with a
 *        clear error instead of producing 1.0.NaN or silently dropping zeros.
 *
 * Run with: npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { bumpVersion } = require('../dist/core/bumpVersion.js');

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

  it('bumps app.json/package.json without throwing when build.gradle is absent (iOS-only flow)', () => {
    writeAppJson(dir, '1.2.3');
    writePkgJson(dir, '1.2.3');

    // No android/ directory at all — must not throw (A3).
    const result = bumpVersion({ cwd: dir });

    assert.strictEqual(result.versionName, '1.2.4');
    assert.strictEqual(result.versionCode, null); // nothing to write a code into
    const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    assert.strictEqual(appJson.expo.version, '1.2.4');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '1.2.4');
    assert.ok(!fs.existsSync(path.join(dir, 'android')), 'no android/ dir should be created');
  });

  it('still writes versionCode/versionName into build.gradle when present', () => {
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

    const result = bumpVersion({ cwd: dir });
    assert.strictEqual(result.versionCode, 6);
    const gradle = fs.readFileSync(gradlePath, 'utf8');
    assert.match(gradle, /versionCode 6/);
    assert.match(gradle, /versionName "1\.2\.4"/);
  });

  it('rejects a non-numeric patch instead of producing 1.0.NaN', () => {
    writeAppJson(dir, '1.2.x');
    assert.throws(() => bumpVersion({ cwd: dir }), /Unexpected patch segment/);
  });

  it('rejects leading-zero patches instead of silently dropping the zero', () => {
    writeAppJson(dir, '1.2.07');
    assert.throws(() => bumpVersion({ cwd: dir }), /Unexpected patch segment/);
  });

  it('rejects pre-release / build-metadata versions with a clear message', () => {
    writeAppJson(dir, '1.2.3-rc.1');
    assert.throws(() => bumpVersion({ cwd: dir }), /not supported by the version bump/);
  });
});

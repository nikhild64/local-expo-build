/**
 * Tests for the iOS-related pure functions. We deliberately do NOT test
 * xcodebuild orchestration here — that requires macOS + Xcode, which CI
 * matrix runners do have, but the commands themselves are inherently
 * environment-dependent. We test what's testable in isolation:
 *  - exportOptions plist generation (string output, deterministic)
 *  - credentials.json iOS section parser (file-based, OS-agnostic)
 *  - xcworkspace detection (file-based, OS-agnostic)
 *  - assertMacOS guard behavior
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  buildExportOptionsPlist,
} = require('../dist/core/ios/exportOptions.js');
const { readIosCredentials } = require('../dist/core/ios/credentials.js');
const { detectIosProject } = require('../dist/core/ios/detect.js');
const { assertMacOS } = require('../dist/util/platform.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leb-ios-'));
}

describe('buildExportOptionsPlist', () => {
  it('produces a valid plist for app-store with manual signing', () => {
    const out = buildExportOptionsPlist({
      method: 'app-store',
      teamId: 'ABCDE12345',
      bundleIdentifier: 'com.example.app',
      provisioningProfileName: 'MyProfile',
    });
    assert.match(out, /<\?xml version="1\.0"/);
    assert.match(out, /<key>method<\/key><string>app-store<\/string>/);
    assert.match(out, /<key>teamID<\/key><string>ABCDE12345<\/string>/);
    assert.match(out, /<key>signingStyle<\/key><string>manual<\/string>/);
    assert.match(out, /<key>provisioningProfiles<\/key>/);
    assert.match(out, /<key>com\.example\.app<\/key>/);
    assert.match(out, /<string>MyProfile<\/string>/);
    assert.match(out, /<key>compileBitcode<\/key><false\/>/);
    // app-store does NOT emit uploadSymbols=false (Apple expects symbols)
    assert.doesNotMatch(out, /<key>uploadSymbols<\/key><false\/>/);
  });

  it('uses automatic signing when no teamId given', () => {
    const out = buildExportOptionsPlist({ method: 'development' });
    assert.match(out, /<key>signingStyle<\/key><string>automatic<\/string>/);
    assert.doesNotMatch(out, /<key>teamID<\/key>/);
    // non-app-store methods emit uploadSymbols=false
    assert.match(out, /<key>uploadSymbols<\/key><false\/>/);
  });

  it('omits provisioningProfiles when bundleId or profile is missing', () => {
    const out = buildExportOptionsPlist({
      method: 'ad-hoc',
      teamId: 'XYZ99',
      // intentionally no bundleIdentifier / provisioningProfileName
    });
    assert.doesNotMatch(out, /<key>provisioningProfiles<\/key>/);
  });

  it('escapes XML-sensitive chars in inputs', () => {
    const out = buildExportOptionsPlist({
      method: 'ad-hoc',
      teamId: 'A&B<C>D',
    });
    assert.match(out, /A&amp;B&lt;C&gt;D/);
    assert.doesNotMatch(out, /A&B<C>D/); // raw < should not appear in the plist body
  });
});

describe('readIosCredentials', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns null when credentials.json is missing', () => {
    assert.strictEqual(readIosCredentials(dir), null);
  });

  it('returns null when credentials.json has no ios section', () => {
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ android: {} }));
    assert.strictEqual(readIosCredentials(dir), null);
  });

  it('returns null when fields are present but referenced files are missing', () => {
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
      ios: {
        distributionCertificate: { path: 'ios/certs/dist.p12', password: 'x' },
        provisioningProfilePath: 'ios/certs/profile.mobileprovision',
      },
    }));
    assert.strictEqual(readIosCredentials(dir), null);
  });

  it('returns absolute paths when all files exist', () => {
    fs.mkdirSync(path.join(dir, 'ios', 'certs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ios', 'certs', 'dist.p12'), 'fake');
    fs.writeFileSync(path.join(dir, 'ios', 'certs', 'profile.mobileprovision'), 'fake');
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
      ios: {
        distributionCertificate: { path: 'ios/certs/dist.p12', password: 'pw' },
        provisioningProfilePath: 'ios/certs/profile.mobileprovision',
      },
    }));
    const result = readIosCredentials(dir);
    assert.ok(result);
    assert.strictEqual(result.distributionCertificatePassword, 'pw');
    assert.strictEqual(result.distributionCertificatePath, 'ios/certs/dist.p12');
    assert.ok(path.isAbsolute(result.absDistributionCertificatePath));
    assert.ok(path.isAbsolute(result.absProvisioningProfilePath));
  });
});

describe('detectIosProject', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns null when ios/ is missing', () => {
    assert.strictEqual(detectIosProject(dir), null);
  });

  it('returns null when ios/ has no .xcworkspace', () => {
    fs.mkdirSync(path.join(dir, 'ios'));
    assert.strictEqual(detectIosProject(dir), null);
  });

  it('returns null when ios/ has more than one .xcworkspace (ambiguous)', () => {
    fs.mkdirSync(path.join(dir, 'ios', 'A.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ios', 'B.xcworkspace'), { recursive: true });
    assert.strictEqual(detectIosProject(dir), null);
  });

  it('returns workspace info when exactly one .xcworkspace exists', () => {
    fs.mkdirSync(path.join(dir, 'ios', 'MyApp.xcworkspace'), { recursive: true });
    const result = detectIosProject(dir);
    assert.ok(result);
    assert.strictEqual(result.workspaceName, 'MyApp');
    assert.strictEqual(result.inferredScheme, 'MyApp');
    assert.ok(result.workspacePath.endsWith('MyApp.xcworkspace'));
  });
});

describe('assertMacOS', () => {
  it('throws with helpful message on non-darwin platforms', () => {
    if (process.platform === 'darwin') {
      // can't test the throw path on a Mac — skip
      return;
    }
    assert.throws(() => assertMacOS('test feature'), /requires macOS/);
  });

  it('does not throw on darwin', () => {
    if (process.platform !== 'darwin') return; // skip on non-Mac
    assert.doesNotThrow(() => assertMacOS('test feature'));
  });
});

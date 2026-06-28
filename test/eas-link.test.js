/**
 * Tests for detectEasLink — classifies project link state for the doctor
 * wizard and the EAS-related auto-fix offers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { detectEasLink, isEasReady } = require('../dist/core/easLink.js');
const { invalidateExpoConfigCache } = require('../dist/core/expoConfig.js');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leb-easlink-'));
}

function writeJson(dir, name, obj) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
}

describe('detectEasLink', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); invalidateExpoConfigCache(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns linked when app.json has expo.extra.eas.projectId', () => {
    writeJson(dir, 'app.json', { expo: { extra: { eas: { projectId: 'abc-123' } } } });
    const result = detectEasLink(dir);
    assert.strictEqual(result.kind, 'linked');
    assert.strictEqual(result.projectId, 'abc-123');
    assert.strictEqual(result.hasEasJson, false);
    assert.strictEqual(result.source, 'app.json');
  });

  it('returns linked + hasEasJson when both app.json projectId and eas.json exist', () => {
    writeJson(dir, 'app.json', { expo: { extra: { eas: { projectId: 'abc-123' } } } });
    writeJson(dir, 'eas.json', { cli: { version: '>= 5.0.0' }, build: {} });
    const result = detectEasLink(dir);
    assert.strictEqual(result.kind, 'linked');
    assert.strictEqual(result.hasEasJson, true);
  });

  it('returns not-linked when app.json exists without projectId', () => {
    writeJson(dir, 'app.json', { expo: { name: 'TestApp' } });
    const result = detectEasLink(dir);
    assert.strictEqual(result.kind, 'not-linked');
    assert.strictEqual(result.hasAppJson, true);
  });

  it('returns no-expo-config when nothing exists', () => {
    const result = detectEasLink(dir);
    assert.strictEqual(result.kind, 'no-expo-config');
  });

  it('returns not-linked when only eas.json exists', () => {
    writeJson(dir, 'eas.json', { cli: { version: '>= 5.0.0' }, build: {} });
    const result = detectEasLink(dir);
    assert.strictEqual(result.kind, 'not-linked');
    assert.strictEqual(result.hasAppJson, false);
    assert.strictEqual(result.hasEasJson, true);
  });
});

describe('isEasReady', () => {
  it('true when linked AND eas.json present', () => {
    assert.strictEqual(
      isEasReady({ kind: 'linked', projectId: 'x', hasEasJson: true, source: 'app.json' }),
      true
    );
  });
  it('false when linked but eas.json missing', () => {
    assert.strictEqual(
      isEasReady({ kind: 'linked', projectId: 'x', hasEasJson: false, source: 'app.json' }),
      false
    );
  });
  it('false when not linked', () => {
    assert.strictEqual(
      isEasReady({ kind: 'not-linked', hasAppJson: true, hasEasJson: true, source: 'app.json' }),
      false
    );
  });
});

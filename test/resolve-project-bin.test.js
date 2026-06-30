const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectPackageManager,
  formatRunScript,
  resolveProjectBin,
} = require('../dist/util/resolveProjectBin');

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('resolveProjectBin', () => {
  it('resolves expo via bin/cli', () => {
    const cwd = mkTemp('leb-expo-cli-');
    const cliPath = path.join(cwd, 'node_modules', 'expo', 'bin', 'cli');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '#!/usr/bin/env node\n');

    const result = resolveProjectBin('expo', cwd);
    assert.ok(result);
    assert.equal(result.command, process.execPath);
    assert.equal(result.prefixArgs[0], cliPath);
  });

  it('falls back to node_modules/.bin shim', () => {
    const cwd = mkTemp('leb-expo-shim-');
    const isWin = process.platform === 'win32';
    const shim = path.join(cwd, 'node_modules', '.bin', isWin ? 'expo.cmd' : 'expo');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, isWin ? '@echo off\n' : '#!/usr/bin/env sh\n');

    const result = resolveProjectBin('expo', cwd);
    assert.ok(result);
    assert.equal(result.command, shim);
    assert.deepEqual(result.prefixArgs, []);
    if (isWin) assert.equal(result.execa?.shell, true);
  });

  it('returns null when package is missing', () => {
    const cwd = mkTemp('leb-expo-missing-');
    assert.equal(resolveProjectBin('expo', cwd), null);
  });
});

describe('detectPackageManager', () => {
  it('reads packageManager field', () => {
    const cwd = mkTemp('leb-pm-field-');
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.2.0' })
    );
    assert.equal(detectPackageManager(cwd), 'bun');
  });

  it('detects bun from lockfile', () => {
    const cwd = mkTemp('leb-pm-lock-');
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
    fs.writeFileSync(path.join(cwd, 'bun.lock'), '');
    assert.equal(detectPackageManager(cwd), 'bun');
  });
});

describe('formatRunScript', () => {
  it('formats bun scripts', () => {
    assert.equal(formatRunScript('bun', 'build:android:aab'), 'bun run build:android:aab');
  });

  it('formats yarn scripts', () => {
    assert.equal(formatRunScript('yarn', 'build:android:aab'), 'yarn build:android:aab');
  });
});

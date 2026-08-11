/**
 * Regression test: the doctor wizard's auto-fix pass (the "Fix all N
 * identified issue(s) automatically?" flow) must surface the EAS-link step in
 * the SAME run. It previously only ran the interactive EAS offer when there
 * were no auto-fixable issues, so an unlinked project was silently deferred to
 * a second invocation.
 *
 * @inquirer/prompts is a frozen ESM namespace, so it is intercepted via
 * Module._load (the compiled CJS accesses `prompts.confirm` at call time).
 * The keystore auto-setup is stubbed so keytool never runs, and the
 * environment is tolerated: with eas-cli present the EAS step appears as the
 * "Run `eas init` now..." confirm; without it, as the "Install eas-cli..."
 * hint — both prove the step ran after the fixes.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/** Runs an async fn with process.stdin.isTTY faked, restoring it afterwards.
 * Unlike a sync-only helper this must keep the flag set across the awaited
 * promise, because `runDoctor` reads it after several awaits. */
async function withTTY(value, fn) {
  const original = process.stdin.isTTY;
  process.stdin.isTTY = value;
  try {
    return await fn();
  } finally {
    process.stdin.isTTY = original;
  }
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-doctor-eas-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'eas-app', version: '1.0.0', dependencies: { expo: '52.0.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'app.json'),
    JSON.stringify(
      {
        expo: {
          name: 'Eas App',
          slug: 'eas-app',
          version: '1.0.0',
          android: { package: 'com.example.easapp' },
        },
      },
      null,
      2
    )
  );
  return dir;
}

let promptLog = [];
let promptScript = [];
const fakePrompts = {
  confirm: async (config) => {
    const msg = String(config.message);
    promptLog.push(msg);
    const rule = promptScript.find((r) => msg.includes(r.match));
    return rule ? rule.result : true;
  },
  select: async () => 'generate',
  input: async () => '',
  password: async () => '',
};

// Intercept @inquirer/prompts BEFORE dist/commands/doctor.js is required so
// the compiled module binds to the fake namespace.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@inquirer/prompts') return fakePrompts;
  return originalLoad.apply(this, arguments);
};

const autoSetupMod = require('../dist/core/keystore/autoSetup.js');
const { runDoctor } = require('../dist/commands/doctor.js');

describe('doctor auto-fix surfaces the EAS link step in the same run', () => {
  let dir;
  let ksCalls;
  let consoleLines;
  let origLog;
  let origAutoSetup;

  beforeEach(() => {
    dir = tmpProject();
    ksCalls = 0;
    consoleLines = [];
    promptLog = [];
    origLog = console.log;
    console.log = (...args) => consoleLines.push(args.join(' '));
    origAutoSetup = autoSetupMod.autoSetupKeystore;
    autoSetupMod.autoSetupKeystore = async () => {
      ksCalls += 1;
      return {
        provider: 'generate',
        storeFile: 'release.p12',
        keyAlias: 'release',
        generatedPassword: 'stub-pass',
        warnings: [],
        params: {},
      };
    };
  });

  afterEach(() => {
    console.log = origLog;
    autoSetupMod.autoSetupKeystore = origAutoSetup;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('offers EAS linking right after fixing the keystore (one run, not two)', async () => {
    // 1 fixable issue: the missing keystore (package present, not EAS-linked,
    // no eas.json requirement). Accept the auto-fix; decline `eas init`.
    promptScript = [
      { match: 'Fix all 1 identified issue(s) automatically?', result: true },
      { match: 'Run `eas init` now to link this project?', result: false },
    ];

    await withTTY(true, () =>
      runDoctor({ cwd: dir, dryRun: false, skipUpdateCheck: true })
    );

    assert.strictEqual(ksCalls, 1, 'the keystore auto-fix should have run');
    const fixAllIdx = promptLog.findIndex((m) => m.includes('Fix all 1 identified issue(s) automatically?'));
    assert.ok(fixAllIdx !== -1, 'the fix-all confirm should have been asked');

    // EAS must be surfaced after the fixes: as the `eas init` confirm when
    // eas-cli is installed, or the install hint when it is not.
    const easPromptIdx = promptLog.findIndex((m) => m.includes('Run `eas init` now to link this project?'));
    const easHint = consoleLines.some((l) => l.includes('Install eas-cli'));
    assert.ok(
      easPromptIdx !== -1 || easHint,
      'the EAS link step must be surfaced after the auto-fixes'
    );
    if (easPromptIdx !== -1) {
      assert.ok(
        easPromptIdx > fixAllIdx,
        'the EAS offer must come after the fix-all prompt'
      );
    }
  });

  it('skips the EAS offer in a non-interactive shell (no prompts at all)', async () => {
    await withTTY(undefined, () =>
      runDoctor({ cwd: dir, dryRun: false, skipUpdateCheck: true, fixAll: true })
    );
    assert.strictEqual(promptLog.length, 0, 'non-TTY must never prompt');
    assert.strictEqual(ksCalls, 1, '--fix still applies the keystore fix');
  });
});

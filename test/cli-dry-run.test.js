/**
 * Regression test for D1: the `keystore` subcommands must honor `--dry-run`
 * and never mutate the project (keytool, file copies, keystore.properties,
 * credentials.json, .gitignore, or --move deletes).
 *
 * The commands are exercised in-process through commander's parseAsync (same
 * code path as the CLI: getCtx → optsWithGlobals → dry-run gate). Spawning
 * `dist/cli.js` as a child process is avoided because node:test on Windows
 * intermittently corrupts a sibling test file's protocol stream when another
 * file synchronously spawns a node process.
 *
 * Run with: npm test (builds dist/ first)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Command } = require('commander');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerKeystoreCommand } = require('../dist/commands/keystore.js');

function newProgram() {
  const program = new Command();
  // Mirror the global options defined in src/cli.ts so getCtx can read them.
  program
    .option('--cwd <path>', 'project directory')
    .option('--dry-run', 'print actions without executing destructive steps');
  registerKeystoreCommand(program);
  return program;
}

async function runKeystore(dir, args) {
  const program = newProgram();
  await program.parseAsync(['--dry-run', '--cwd', dir, 'keystore', ...args], { from: 'user' });
}

describe('keystore commands honor --dry-run (D1)', () => {
  it('keystore create --dry-run announces the action and writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-dry-ks-'));
    try {
      await runKeystore(dir, ['create']);

      assert.ok(!fs.existsSync(path.join(dir, 'keystore.properties')), 'must not write keystore.properties');
      assert.ok(!fs.existsSync(path.join(dir, 'credentials.json')), 'must not write credentials.json');
      assert.ok(!fs.existsSync(path.join(dir, '.gitignore')), 'must not write .gitignore');
      assert.ok(!fs.existsSync(path.join(dir, 'android')), 'must not create android/');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('keystore rehydrate --move --dry-run does not delete the source keystore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-dry-rh-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'credentials.json'),
        JSON.stringify({
          android: {
            keystore: {
              keystorePath: 'credentials/android/keystore.jks',
              keystorePassword: 'sp123',
              keyAlias: 'release',
              keyPassword: 'kp123',
            },
          },
        }, null, 2)
      );
      const src = path.join(dir, 'credentials', 'android', 'keystore.jks');
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, 'fake-keystore');

      await runKeystore(dir, ['rehydrate', '--move']);

      assert.ok(fs.existsSync(src), 'dry-run must not delete the source keystore');
      assert.ok(!fs.existsSync(path.join(dir, 'keystore.properties')), 'must not write keystore.properties');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

/**
 * Regression tests for the bare-invocation default: running `local-expo-build`
 * with no subcommand starts the `init` setup wizard inside an Expo project
 * (instead of printing a bare usage screen), and prints a hint — writing
 * nothing — anywhere else.
 *
 * Exercised in-process through the same exported functions the CLI uses
 * (`runDefaultCommand` / `runInit` / `isExpoProject`), matching the pattern in
 * cli-dry-run.test.js. The real dist/cli.js entry is not importable because it
 * self-executes `parseAsync(process.argv)` on require.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Command } = require('commander');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runInit, isExpoProject, runDefaultCommand } = require('../dist/commands/init.js');

function fakeExpoProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-default-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'default-app',
      version: '1.0.0',
      dependencies: { expo: '52.0.0' },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'app.json'),
    JSON.stringify({
      expo: {
        name: 'Default App',
        slug: 'default-app',
        version: '1.0.0',
        android: { package: 'com.example.defaultapp' },
      },
    }, null, 2)
  );
  return dir;
}

// Mirrors the global options defined in src/cli.ts so getCtx can read --cwd.
function programWithCwd(cwd) {
  const program = new Command();
  program
    .option('--cwd <path>', 'project directory')
    .option('--dry-run', 'print actions without executing destructive steps');
  program.setOptionValue('cwd', cwd);
  return program;
}

describe('isExpoProject (bare-invocation guard)', () => {
  it('recognizes a project whose package.json declares expo', () => {
    const dir = fakeExpoProject();
    try {
      assert.strictEqual(isExpoProject(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty / non-Expo directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-default-non-expo-'));
    try {
      assert.strictEqual(isExpoProject(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runInit scaffolds the project (--no-doctor --no-keystore)', () => {
  it('writes scripts/*.js, package.json entries, and .gitignore entries', async () => {
    const dir = fakeExpoProject();
    try {
      await runInit({ doctor: false, keystore: false }, programWithCwd(dir));

      assert.ok(fs.existsSync(path.join(dir, 'scripts', 'build.js')), 'scripts/build.js should be scaffolded');
      assert.ok(fs.existsSync(path.join(dir, 'scripts', 'setup-signing.js')), 'scripts/setup-signing.js should be scaffolded');

      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.strictEqual(pkg.scripts['build:android:apk'], 'node scripts/build.js apk');
      assert.strictEqual(pkg.scripts['build:android:aab'], 'node scripts/build.js aab');

      const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      for (const entry of ['keystore.properties', '*.jks', '*.p12', 'credentials.json']) {
        assert.ok(gi.includes(entry), `.gitignore should contain "${entry}"`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent and keeps existing scripts without --force', async () => {
    const dir = fakeExpoProject();
    try {
      await runInit({ doctor: false, keystore: false }, programWithCwd(dir));
      const buildJs = fs.readFileSync(path.join(dir, 'scripts', 'build.js'), 'utf8');
      await runInit({ doctor: false, keystore: false }, programWithCwd(dir));
      assert.strictEqual(fs.readFileSync(path.join(dir, 'scripts', 'build.js'), 'utf8'), buildJs, 'existing scripts must not be overwritten without --force');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runDefaultCommand (bare invocation)', () => {
  it('prints a hint and writes nothing when the directory is not an Expo project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leb-default-empty-'));
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await runDefaultCommand(programWithCwd(dir));

      assert.ok(
        logs.some((l) => /does not look like an Expo project/i.test(l)),
        'should explain the directory is not an Expo project'
      );
      assert.deepStrictEqual(fs.readdirSync(dir), [], 'must not write anything in a non-Expo directory');
    } finally {
      console.log = origLog;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes into the init wizard inside an Expo project (non-TTY pre-flight abort)', async () => {
    const dir = fakeExpoProject();
    const logs = [];
    const origLog = console.log;
    // Force at least one failing doctor check deterministically, regardless of
    // the host environment (ANDROID_HOME/ANDROID_SDK_ROOT unset). The fake
    // project also has no node_modules, so the expo-CLI check fails too.
    const origAndroidHome = process.env.ANDROID_HOME;
    const origAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    process.env.ANDROID_HOME = '';
    process.env.ANDROID_SDK_ROOT = '';
    console.log = (...args) => logs.push(args.join(' '));
    try {
      // The wizard path prints a dim preamble, then the doctor pre-flight fails
      // and there is no TTY to confirm — so runInit aborts with a clear error
      // instead of scaffolding (and instead of crashing inside @inquirer).
      await assert.rejects(
        () => runDefaultCommand(programWithCwd(dir)),
        /still failing and no interactive terminal/
      );
      assert.ok(
        logs.some((l) => /No command given — running the setup wizard/i.test(l)),
        'bare invocation should announce the init wizard'
      );
    } finally {
      console.log = origLog;
      if (origAndroidHome === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = origAndroidHome;
      if (origAndroidSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
      else process.env.ANDROID_SDK_ROOT = origAndroidSdkRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

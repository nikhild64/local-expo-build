/**
 * Unit tests for the expo prebuild step (src/core/prebuild.ts).
 *
 * expo CLI removed `--non-interactive` in SDK 54 ("use $CI=1 instead"), so
 * prebuild must spawn `expo prebuild` without that flag and with CI=1 in the
 * environment. The pure helpers prebuildArgs / prebuildEnv are exactly the
 * values handed to the spawned process, so testing them pins the regression
 * without needing a real expo install (execa v9 is ESM and cannot be
 * monkeypatched from CJS tests).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { prebuildArgs, prebuildEnv } = require('../dist/core/prebuild.js');

describe('prebuildArgs — expo prebuild invocation (SDK 54+)', () => {
  it('drops --non-interactive (removed in expo CLI) and targets android', () => {
    const args = prebuildArgs(false);
    assert.ok(!args.includes('--non-interactive'), 'must not pass the removed flag');
    assert.deepStrictEqual(args, ['prebuild', '--platform', 'android']);
  });

  it('appends --clean when requested', () => {
    assert.deepStrictEqual(prebuildArgs(true), [
      'prebuild',
      '--platform',
      'android',
      '--clean',
    ]);
  });
});

describe('prebuildEnv — non-interactivity via CI=1', () => {
  it('sets CI=1 (the SDK 54 replacement for --non-interactive)', () => {
    assert.strictEqual(prebuildEnv().CI, '1');
  });

  it('preserves the surrounding environment', () => {
    const prev = process.env.EXPO_PUBLIC_TEST_VAR;
    try {
      process.env.EXPO_PUBLIC_TEST_VAR = 'keep-me';
      const env = prebuildEnv();
      assert.strictEqual(env.EXPO_PUBLIC_TEST_VAR, 'keep-me');
    } finally {
      if (prev === undefined) delete process.env.EXPO_PUBLIC_TEST_VAR;
      else process.env.EXPO_PUBLIC_TEST_VAR = prev;
    }
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  formatCliUpdateMessage,
  forwardCliArgv,
  isCliUpdateAvailable,
} = require('../dist/util/checkCliUpdate');
const { formatCliInvoke, getRunnerInvocation } = require('../dist/util/resolveProjectBin');

describe('checkCliUpdate', () => {
  it('isCliUpdateAvailable when registry is newer', () => {
    assert.equal(isCliUpdateAvailable('0.4.1', '0.4.2'), true);
    assert.equal(isCliUpdateAvailable('0.4.2', '0.4.2'), false);
    assert.equal(isCliUpdateAvailable('0.4.2', '0.4.1'), false);
  });

  it('formatCliUpdateMessage suggests bunx for bun projects', () => {
    const msg = formatCliUpdateMessage({ current: '0.4.1', latest: '0.4.2' }, 'bun', 'init');
    assert.match(msg, /0\.4\.1 → 0\.4\.2/);
    assert.match(msg, /bunx local-expo-build@latest init/);
  });

  it('formatCliInvoke uses npx by default', () => {
    assert.equal(formatCliInvoke('npm', 'doctor'), 'npx local-expo-build@latest doctor');
  });

  it('forwardCliArgv drops the package name when present', () => {
    assert.deepEqual(
      forwardCliArgv(['node', 'cli.js', 'local-expo-build', 'init', '--force']),
      ['init', '--force']
    );
    assert.deepEqual(forwardCliArgv(['node', 'cli.js', 'init', '--force']), ['init', '--force']);
  });

  it('getRunnerInvocation uses bunx for bun', () => {
    assert.deepEqual(getRunnerInvocation('bun'), {
      command: 'bunx',
      args: ['local-expo-build@latest'],
    });
  });
});

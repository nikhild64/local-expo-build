const { describe, it } = require('node:test');
const assert = require('node:assert');
const { gradleOptsWithRam, nodeOptionsWithRam, parseRamMb } = require('../dist/util/ram.js');

describe('parseRamMb utility', () => {
  it('returns null for default or empty values', () => {
    assert.strictEqual(parseRamMb(undefined), null);
    assert.strictEqual(parseRamMb(''), null);
    assert.strictEqual(parseRamMb('default'), null);
  });

  it('parses gigabytes notation correctly', () => {
    assert.strictEqual(parseRamMb('2g'), 2048);
    assert.strictEqual(parseRamMb('4G'), 4096);
    assert.strictEqual(parseRamMb('8g'), 8192);
    assert.strictEqual(parseRamMb('16g'), 16384);
  });

  it('parses megabytes notation correctly', () => {
    assert.strictEqual(parseRamMb('2048m'), 2048);
    assert.strictEqual(parseRamMb('4096M'), 4096);
  });

  it('treats pure numbers as gigabytes', () => {
    assert.strictEqual(parseRamMb('4'), 4096);
    assert.strictEqual(parseRamMb('8'), 8192);
  });

  it('throws on garbage input so a typo is never silently ignored (D7)', () => {
    assert.throws(() => parseRamMb('invalid'), /Invalid --max-ram/);
    assert.throws(() => parseRamMb('abc'), /Invalid --max-ram/);
    assert.throws(() => parseRamMb('2x'), /Invalid --max-ram/);
    assert.throws(() => parseRamMb('8 g'), /Invalid --max-ram/);
  });

  it('throws on zero so it is never silently ignored (D7)', () => {
    assert.throws(() => parseRamMb('0'), /positive amount/);
    assert.throws(() => parseRamMb('0g'), /positive amount/);
    assert.throws(() => parseRamMb('0m'), /positive amount/);
  });

  it('throws on values above the 64g cap instead of passing them to Gradle (D7)', () => {
    assert.throws(() => parseRamMb('65g'), /max supported is 64g/);
    assert.throws(() => parseRamMb('65537m'), /max supported is 64g/);
  });

  it('accepts the cap boundary exactly', () => {
    assert.strictEqual(parseRamMb('64g'), 65536);
    assert.strictEqual(parseRamMb('65536m'), 65536);
  });
});

describe('RAM env appending (D6)', () => {
  it('nodeOptionsWithRam appends to an existing value instead of clobbering it', () => {
    const out = nodeOptionsWithRam(4096, '--openssl-legacy-provider');
    assert.strictEqual(out, '--openssl-legacy-provider --max-old-space-size=4096');
    assert.ok(out.includes('--openssl-legacy-provider'), 'existing flag must survive');
    assert.ok(out.includes('--max-old-space-size=4096'), 'heap flag must be appended');
  });

  it('nodeOptionsWithRam handles an empty existing value', () => {
    assert.strictEqual(nodeOptionsWithRam(2048, undefined), '--max-old-space-size=2048');
    assert.strictEqual(nodeOptionsWithRam(2048, ''), '--max-old-space-size=2048');
  });

  it('gradleOptsWithRam appends the JVM flags to an existing value', () => {
    const out = gradleOptsWithRam(4096, '-Dorg.gradle.daemon=false');
    assert.ok(out.startsWith('-Dorg.gradle.daemon=false '), 'existing Gradle args must survive');
    assert.ok(out.includes('-Xmx4096m'), 'heap cap must be appended');
    assert.ok(out.includes('-XX:MaxMetaspaceSize=1024m'), 'metaspace for <8g is 1024m');
  });

  it('gradleOptsWithRam uses a larger metaspace at 8g and above', () => {
    const out = gradleOptsWithRam(8192, undefined);
    assert.ok(out.includes('-XX:MaxMetaspaceSize=1536m'), 'metaspace for >=8g is 1536m');
  });
});

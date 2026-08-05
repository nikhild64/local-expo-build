const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseRamMb } = require('../dist/util/ram.js');

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

  it('returns null for invalid inputs', () => {
    assert.strictEqual(parseRamMb('invalid'), null);
    assert.strictEqual(parseRamMb('abc'), null);
  });
});

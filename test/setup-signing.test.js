/**
 * Tests for the gradle injection strategies in src/core/setupSigning.ts.
 * The injection is the most fragile bit of the whole CLI — it regex-touches
 * Expo's generated build.gradle, and the template shifts every few SDKs.
 *
 * Run with: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  injectReleaseSigningConfig,
  wireReleaseBuildType,
} = require('../dist/core/setupSigning.js');

const PROPS = {
  storeFile: 'release.jks',
  storePassword: 'pw1',
  keyAlias: 'release',
  keyPassword: 'pw2',
};

// Approximation of Expo's current prebuild output for android/app/build.gradle.
const DEFAULT_EXPO_GRADLE = `
apply plugin: "com.android.application"

android {
    namespace 'com.example.app'

    defaultConfig {
        applicationId 'com.example.app'
        versionCode 1
        versionName "1.0"
    }

    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

describe('injectReleaseSigningConfig', () => {
  it('uses exact-match strategy on unmodified Expo output', () => {
    const result = injectReleaseSigningConfig(DEFAULT_EXPO_GRADLE, PROPS);
    assert.ok(result, 'should not return null');
    assert.strictEqual(result.strategy, 'exact-match');
    assert.match(result.gradle, /release\s*\{[\s\S]*storeFile file\('release\.jks'\)/);
    assert.match(result.gradle, /storePassword 'pw1'/);
    assert.match(result.gradle, /keyAlias 'release'/);
  });

  it('falls back to block-inject when debug block has a comment', () => {
    // Adding a comment inside the debug block breaks exact match but the
    // tolerant strategy should still find the signingConfigs container.
    const gradle = DEFAULT_EXPO_GRADLE.replace(
      "keyPassword 'android'",
      "keyPassword 'android' // pinned by expo prebuild"
    );
    const result = injectReleaseSigningConfig(gradle, PROPS);
    assert.ok(result);
    assert.strictEqual(result.strategy, 'block-inject');
    assert.match(result.gradle, /release\s*\{[\s\S]*storeFile file\('release\.jks'\)/);
    // The debug block should be preserved unchanged
    assert.match(result.gradle, /debug\s*\{[\s\S]*keyPassword 'android'/);
  });

  it('falls back to block-inject when whitespace differs', () => {
    // 2-space indent instead of 4-space
    const gradle = DEFAULT_EXPO_GRADLE.replace(/^    signingConfigs/m, '  signingConfigs');
    const result = injectReleaseSigningConfig(gradle, PROPS);
    assert.ok(result);
    assert.strictEqual(result.strategy, 'block-inject');
  });

  it('uses synthesize strategy when no signingConfigs block exists at all', () => {
    // Strip the entire signingConfigs block (hypothetical future Expo template)
    const gradle = DEFAULT_EXPO_GRADLE.replace(
      /\n\s*signingConfigs\s*\{[\s\S]*?\n\s*\}\s*\n/,
      '\n'
    );
    const result = injectReleaseSigningConfig(gradle, PROPS);
    assert.ok(result, 'should synthesize a new signingConfigs block');
    assert.strictEqual(result.strategy, 'synthesize');
    assert.match(result.gradle, /signingConfigs\s*\{[\s\S]*release\s*\{[\s\S]*storeFile/);
  });

  it('returns null when there is no android block at all', () => {
    const result = injectReleaseSigningConfig('// not a real build.gradle', PROPS);
    assert.strictEqual(result, null);
  });

  it('injected gradle is valid for the wireReleaseBuildType pass', () => {
    // The two functions are called back-to-back in setupSigning; the second
    // should be able to wire up the buildType after the first injects.
    const injected = injectReleaseSigningConfig(DEFAULT_EXPO_GRADLE, PROPS);
    const wired = wireReleaseBuildType(injected.gradle);
    assert.ok(wired.changed);
    assert.match(wired.gradle, /release\s*\{[\s\S]*signingConfig signingConfigs\.release/);
  });
});

describe('wireReleaseBuildType', () => {
  it('rewires the release buildType signingConfig from debug to release', () => {
    const result = wireReleaseBuildType(DEFAULT_EXPO_GRADLE);
    assert.ok(result.changed);
    // After wiring, the release block should reference signingConfigs.release
    const m = result.gradle.match(/buildTypes\s*\{[\s\S]*release\s*\{([\s\S]*?)\n\s*\}/);
    assert.ok(m, 'release block found');
    assert.match(m[1], /signingConfig signingConfigs\.release/);
  });

  it('is idempotent — no change when already wired', () => {
    const wired = wireReleaseBuildType(DEFAULT_EXPO_GRADLE).gradle;
    const result = wireReleaseBuildType(wired);
    assert.strictEqual(result.changed, false);
  });

  it('handles a gradle with only one signingConfig debug line (strategy B)', () => {
    // Future template might only have the debug line in release, with no
    // signingConfig in debug buildType. Synthesized gradle.
    const minimal = `
android {
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;
    const result = wireReleaseBuildType(minimal);
    assert.ok(result.changed);
    assert.match(result.gradle, /signingConfig signingConfigs\.release/);
  });
});

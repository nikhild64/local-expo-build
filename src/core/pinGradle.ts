import fs from 'fs';
import path from 'path';
import { log } from '../util/log';

/**
 * Pinning table. `null` = no pin needed for that SDK.
 *
 * SDK 55: pinned to 8.13 because Gradle 9.0.0 (the default in Expo 55's
 * prebuild template) breaks expo-manifests with:
 *   > SoftwareComponent with name 'release' not found.
 * Gradle 8.13 evaluates project configuration in the order expo-modules expect.
 */
export const GRADLE_PIN: Record<number, string | null> = {
  50: null,
  51: null,
  52: null,
  53: null,
  54: null,
  55: '8.13',
  56: null,
};

export interface PinGradleOpts {
  cwd: string;
  sdk: number;
}

export function pinGradle({ cwd, sdk }: PinGradleOpts): void {
  const pin = GRADLE_PIN[sdk];
  if (!pin) {
    log.dim(`[pin-gradle] SDK ${sdk}: no pin required, skipping.`);
    return;
  }
  const wrapper = path.join(cwd, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!fs.existsSync(wrapper)) {
    log.warn(`[pin-gradle] ${wrapper} not found; run prebuild first.`);
    return;
  }
  const raw = fs.readFileSync(wrapper, 'utf8');
  const reUrl = /^distributionUrl=.*/m;
  const desired = `distributionUrl=https\\://services.gradle.org/distributions/gradle-${pin}-bin.zip`;
  const current = raw.match(reUrl)?.[0] ?? '';
  if (current === desired) {
    log.ok(`[pin-gradle] already pinned to Gradle ${pin}`);
    return;
  }
  fs.writeFileSync(wrapper, raw.replace(reUrl, desired), 'utf8');
  log.ok(
    `[pin-gradle] pinned Gradle wrapper to ${pin} (was: ${
      current.split('gradle-')[1] ?? '?'
    })`
  );
}

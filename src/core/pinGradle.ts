import fs from 'fs';
import path from 'path';
import { log } from '../util/log';

/**
 * Bundled pinning table. Used as offline fallback when the remote manifest
 * can't be reached. `null` = no pin needed for that SDK.
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

/**
 * URL of the live manifest. Update the file in `manifest/gradle-pins.json` in
 * the repo and all users on any CLI version get the new pin on their next
 * build — no `npm publish` required. The remote manifest takes precedence
 * over the bundled table when both define an SDK.
 */
const REMOTE_MANIFEST_URL =
  'https://raw.githubusercontent.com/nikhild64/local-expo-build/main/manifest/gradle-pins.json';

// undefined = not yet tried; null = tried and failed; object = success.
let cachedRemote: Record<number, string | null> | null | undefined;

async function fetchRemotePins(): Promise<Record<number, string | null> | null> {
  if (cachedRemote !== undefined) return cachedRemote;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(REMOTE_MANIFEST_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      cachedRemote = null;
      return null;
    }
    const parsed = (await res.json()) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      cachedRemote = null;
      return null;
    }
    // Normalize: keys may arrive as strings from JSON.
    const out: Record<number, string | null> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const major = Number(k);
      if (!Number.isInteger(major)) continue;
      if (v === null || typeof v === 'string') out[major] = v;
    }
    cachedRemote = out;
    return out;
  } catch {
    cachedRemote = null;
    return null;
  }
}

/**
 * Resolves the Gradle pin for an Expo SDK. Tries the remote manifest first
 * (3s timeout, falls back silently), then the bundled table.
 */
export async function resolveGradlePin(sdk: number): Promise<string | null> {
  const remote = await fetchRemotePins();
  if (remote && sdk in remote) return remote[sdk];
  return GRADLE_PIN[sdk] ?? null;
}

export interface PinGradleOpts {
  cwd: string;
  sdk: number;
}

export async function pinGradle({ cwd, sdk }: PinGradleOpts): Promise<void> {
  const pin = await resolveGradlePin(sdk);
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

import fs from 'fs';
import path from 'path';
import { execaSync } from 'execa';

/**
 * Returns the resolved Expo config (the inner `expo` object — so the call
 * sites read `config.android.package` and `config.extra.eas.projectId`,
 * never `config.expo.android.package`).
 *
 * Resolution order:
 *  1. If `app.config.js` / `app.config.ts` exists, shell out to
 *     `npx expo config --json --type public`. This is the source of truth
 *     for dynamic configs; static `app.json` (if any) gets merged in by the
 *     Expo CLI itself.
 *  2. Otherwise, parse `app.json` directly (fast path — no spawn).
 *  3. Otherwise, return `null` (not an Expo project, or config unreadable).
 *
 * Result is cached per-process. Call `invalidateExpoConfigCache(cwd)` after
 * mutating `app.json` so doctor's re-checks pick up the new state.
 */
export interface ExpoConfigResult {
  /** The resolved `expo` config object (already unwrapped). */
  config: any;
  /** Where the config came from — affects whether it's safe to auto-write. */
  source: 'app.json' | 'dynamic';
}

const cache = new Map<string, ExpoConfigResult | null>();

export function readExpoConfig(cwd: string): ExpoConfigResult | null {
  if (cache.has(cwd)) return cache.get(cwd) ?? null;

  const hasDynamic =
    fs.existsSync(path.join(cwd, 'app.config.js')) ||
    fs.existsSync(path.join(cwd, 'app.config.ts')) ||
    fs.existsSync(path.join(cwd, 'app.config.cjs')) ||
    fs.existsSync(path.join(cwd, 'app.config.mjs'));

  if (hasDynamic) {
    const fromDynamic = readDynamicConfig(cwd);
    if (fromDynamic) {
      cache.set(cwd, fromDynamic);
      return fromDynamic;
    }
    // Fall through to app.json (some projects keep both; dynamic just augments).
  }

  const appJsonPath = path.join(cwd, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      const inner = raw?.expo ?? raw ?? null;
      if (inner && typeof inner === 'object') {
        const result: ExpoConfigResult = { config: inner, source: 'app.json' };
        cache.set(cwd, result);
        return result;
      }
    } catch {
      // malformed app.json — fall through
    }
  }

  cache.set(cwd, null);
  return null;
}

export function invalidateExpoConfigCache(cwd?: string): void {
  if (cwd) cache.delete(cwd);
  else cache.clear();
}

function readDynamicConfig(cwd: string): ExpoConfigResult | null {
  try {
    const result = execaSync(
      'npx',
      ['--no-install', 'expo', 'config', '--json', '--type', 'public'],
      {
        cwd,
        reject: false,
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (result.exitCode !== 0 || !result.stdout) return null;
    const parsed = JSON.parse(result.stdout);
    const inner = parsed?.expo ?? parsed;
    if (!inner || typeof inner !== 'object') return null;
    return { config: inner, source: 'dynamic' };
  } catch {
    return null;
  }
}

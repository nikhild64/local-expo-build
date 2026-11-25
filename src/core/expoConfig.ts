import fs from 'fs';
import path from 'path';
import { execaSync } from 'execa';
import { log } from '../util/log';
import { projectBinExecArgs, resolveProjectBin } from '../util/resolveProjectBin';
import { evaluateStaticDynamicConfig, findDynamicConfigFile } from './expoConfigEdit';

/**
 * Returns the resolved Expo config (the inner `expo` object — so the call
 * sites read `config.android.package` and `config.extra.eas.projectId`,
 * never `config.expo.android.package`).
 *
 * Resolution order:
 *  1. If `app.config.ts` / `app.config.js` / `.cjs` / `.mjs` exists, shell out
 *     to the local `expo config --json --type public` (source of truth for
 *     dynamic configs; static `app.json` gets merged in by Expo CLI itself).
 *     If the local Expo CLI is unavailable or fails, fall back to static AST
 *     evaluation when the config fields are statically resolvable.
 *  2. Otherwise, parse `app.json` directly (fast path — no spawn).
 *  3. Otherwise, return `null` (not an Expo project, or config unreadable).
 *
 * Result is cached per-process. Call `invalidateExpoConfigCache(cwd)` after
 * mutating `app.json` or `app.config.*` so subsequent checks pick up changes.
 */
export interface ExpoConfigResult {
  /** The resolved `expo` config object (already unwrapped). */
  config: any;
  /** Where the config came from — affects whether edits target app.json or app.config.*. */
  source: 'app.json' | 'dynamic';
}

const cache = new Map<string, ExpoConfigResult | null>();

export function readExpoConfig(cwd: string): ExpoConfigResult | null {
  if (cache.has(cwd)) return cache.get(cwd) ?? null;

  const dynamicPath = findDynamicConfigFile(cwd);
  if (dynamicPath) {
    const fromDynamic = readDynamicConfig(cwd);
    if (fromDynamic) {
      cache.set(cwd, fromDynamic);
      log.debug(`Expo config: resolved ${path.basename(dynamicPath)} via expo CLI`);
      return fromDynamic;
    }

    const fromStaticAst = evaluateStaticDynamicConfig(cwd, dynamicPath);
    if (fromStaticAst) {
      const result: ExpoConfigResult = { config: fromStaticAst.config, source: 'dynamic' };
      cache.set(cwd, result);
      log.debug(`Expo config: resolved ${path.basename(dynamicPath)} via static AST fallback`);
      return result;
    }

    cache.set(cwd, null);
    return null;
  }

  // Fast path: if only app.json exists, read it directly without spawning external CLI processes
  const appJsonPath = path.join(cwd, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      const inner = raw?.expo ?? raw ?? null;
      if (inner && typeof inner === 'object') {
        const result: ExpoConfigResult = { config: inner, source: 'app.json' };
        cache.set(cwd, result);
        log.debug(`Expo config: read ${path.relative(cwd, appJsonPath) || 'app.json'} (static)`);
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

function parseJsonFromCliStdout(stdout: string): any | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Configs using dotenv v17 or console.log can emit log lines to stdout before the JSON.
    for (let idx = trimmed.indexOf('{'); idx !== -1; idx = trimmed.indexOf('{', idx + 1)) {
      try {
        return JSON.parse(trimmed.slice(idx));
      } catch {
        // continue scanning for the JSON object boundary
      }
    }
    return null;
  }
}

function readDynamicConfig(cwd: string): ExpoConfigResult | null {
  const bin = resolveProjectBin('expo', cwd);
  if (!bin) return null;

  try {
    const { command, args, execa: execaOpts } = projectBinExecArgs(bin, [
      'config',
      '--json',
      '--type',
      'public',
    ]);
    const result = execaSync(command, args, {
      cwd,
      reject: false,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...execaOpts,
    });
    if (result.exitCode !== 0 || !result.stdout) return null;
    const parsed = parseJsonFromCliStdout(result.stdout);
    if (!parsed) return null;
    const inner = parsed?.expo ?? parsed;
    if (!inner || typeof inner !== 'object') return null;
    return { config: inner, source: 'dynamic' };
  } catch {
    return null;
  }
}

import fs from 'fs';
import path from 'path';
import { readExpoConfig } from './expoConfig';

export type EasLinkResult =
  | { kind: 'linked'; projectId: string; hasEasJson: boolean; source: 'app.json' | 'dynamic' }
  | { kind: 'not-linked'; hasAppJson: boolean; hasEasJson: boolean; source: 'app.json' | 'dynamic' }
  | { kind: 'dynamic-unreadable'; hasEasJson: boolean }
  | { kind: 'no-expo-config' };

/**
 * Statically classify whether an Expo project is linked to an EAS project.
 *
 * Uses `readExpoConfig` so this works for both `app.json` and dynamic
 * `app.config.{js,ts}` configs. When a dynamic config exists but the Expo
 * CLI can't resolve it (not installed, syntax error, etc.) we return
 * `dynamic-unreadable` so the caller can warn instead of pretending.
 */
export function detectEasLink(cwd: string): EasLinkResult {
  const hasEasJson = fs.existsSync(path.join(cwd, 'eas.json'));
  const hasAppJson = fs.existsSync(path.join(cwd, 'app.json'));
  const hasDynamic =
    fs.existsSync(path.join(cwd, 'app.config.js')) ||
    fs.existsSync(path.join(cwd, 'app.config.ts')) ||
    fs.existsSync(path.join(cwd, 'app.config.cjs')) ||
    fs.existsSync(path.join(cwd, 'app.config.mjs'));

  const resolved = readExpoConfig(cwd);

  if (resolved) {
    const projectId: string | undefined = resolved.config?.extra?.eas?.projectId;
    if (projectId) {
      return { kind: 'linked', projectId, hasEasJson, source: resolved.source };
    }
    return {
      kind: 'not-linked',
      hasAppJson: resolved.source === 'app.json' ? true : hasAppJson,
      hasEasJson,
      source: resolved.source,
    };
  }

  if (hasDynamic) return { kind: 'dynamic-unreadable', hasEasJson };
  if (hasEasJson) {
    return { kind: 'not-linked', hasAppJson: false, hasEasJson: true, source: 'app.json' };
  }
  return { kind: 'no-expo-config' };
}

/**
 * Returns true when the project has enough state for `eas credentials` and
 * other project-scoped EAS commands to run. EAS requires BOTH a projectId
 * (linked) AND an eas.json (build config). `eas init` writes the projectId;
 * `eas build:configure` writes eas.json. They're independent.
 */
export function isEasReady(result: EasLinkResult): boolean {
  if (result.kind === 'linked') return result.hasEasJson;
  if (result.kind === 'dynamic-unreadable') return result.hasEasJson;
  return false;
}

/** True iff the project is linked (has a projectId we can statically see). */
export function hasProjectId(result: EasLinkResult): boolean {
  return result.kind === 'linked';
}

import { readKeystoreProps, KeystoreProps } from '../setupSigning';
import { writeCredentialsJson } from '../writeCredentialsJson';
import { ensureGitignoreEntries } from '../../util/gitignore';
import { log } from '../../util/log';
import { findRehydrateCandidate, rehydrateFromCredentialsJson, RehydrateOpts } from './rehydrate';
import { fetchEasKeystore } from './easApiFetch';
import { generateKeystore, GenerateKeystoreParams } from './generate';
import { EasAuth, resolveEasAuth } from '../eas/api';

/**
 * Shared "auto-setup" keystore chain — the single implementation of the
 * rehydrate → EAS fetch → generate decision that the browser UI (via the
 * `/api/keystore/auto-setup` route) and the CLI (doctor --fix, the build
 * pre-flight) both use.
 *
 * Provider order (first success wins):
 *   1. `existing`   — keystore.properties already valid (no-op fast path).
 *   2. `rehydrate`  — credentials.json + .jks on disk (no password re-entry).
 *   3. `eas`        — project linked (`opts.projectId`) AND auth available;
 *                     fetch the cloud keystore (overwrites the local copy).
 *   4. `generate`   — local keytool generation with a fresh random password
 *                     (always attempted last; throws if it fails).
 *
 * Failed attempts at steps 2–3 are non-fatal and collected in `warnings`
 * (the next provider still runs). A failed generation is fatal — there is
 * nothing left to fall back to.
 */
export type AutoSetupProvider = 'existing' | 'rehydrate' | 'eas' | 'generate';

export interface AutoSetupKeystoreOpts {
  /**
   * EAS project id (from `detectEasLink`) when the project is linked.
   * Enables the EAS-fetch step; omitted when not linked.
   */
  projectId?: string;
  /**
   * EAS auth for the fetch step. Defaults to `resolveEasAuth()`
   * (EXPO_TOKEN or an `eas login` session); pass `null` to skip EAS.
   */
  auth?: EasAuth | null;
  /** Overrides for local generation (filename, alias, org, ...). */
  generateParams?: GenerateKeystoreParams;
  /** Forwarded to the rehydrate provider. */
  rehydrate?: RehydrateOpts;
}

export interface AutoSetupKeystoreResult {
  provider: AutoSetupProvider;
  storeFile: string;
  keyAlias: string;
  /** Present only when `provider === 'generate'` — shown once to the user. */
  generatedPassword?: string;
  /**
   * The exact params used for local generation (defaults + overrides + the
   * fresh password). Present only when `provider === 'generate'`, so UI
   * surfaces can display the filename/alias/identity without falling back to
   * client-side defaults.
   */
  params?: GenerateKeystoreParams;
  /** Non-fatal notes from failed rehydrate / EAS attempts. */
  warnings: string[];
}

export const GENERATE_DEFAULTS: GenerateKeystoreParams = {
  filename: 'release.p12',
  keyAlias: 'release',
  cn: 'Release Signer',
  org: 'LocalExpoBuild',
  country: 'US',
};

/** Same random-password scheme the UI and doctor's fix-all have always used. */
function randomPassword(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36))
    .join('')
    .slice(0, 16);
}

/**
 * Non-interactive local generation with the auto defaults and a fresh random
 * password. Shared by {@link autoSetupKeystore} and the UI's
 * `/api/keystore/setup` generate route so every "generate with auto settings"
 * path — UI, CLI fix-all, build pre-flight — uses one implementation and the
 * shown-once password always comes from the server.
 */
export interface AutoGenerateKeystoreResult {
  generatedPassword: string;
  storeFile: string;
  keyAlias: string;
  /** The exact params handed to keytool (defaults + overrides + password). */
  params: GenerateKeystoreParams;
}

export async function autoGenerateKeystore(
  cwd: string,
  overrides: GenerateKeystoreParams = {}
): Promise<AutoGenerateKeystoreResult> {
  const pass = randomPassword();
  const params: GenerateKeystoreParams = {
    ...GENERATE_DEFAULTS,
    ...overrides,
    // A fresh random password always wins over any caller-provided one.
    storePassword: pass,
    keyPassword: pass,
  };
  await generateKeystore(cwd, params);
  const props = readKeystoreProps(cwd)!;
  finalize(cwd, props);
  log.ok(`Generated ${params.filename} keystore (alias=${params.keyAlias}).`);
  return { generatedPassword: pass, storeFile: props.storeFile, keyAlias: props.keyAlias, params };
}

function finalize(cwd: string, props: KeystoreProps): void {
  ensureGitignoreEntries(cwd, ['keystore.properties', '*.jks', '*.p12', 'credentials.json']);
  writeCredentialsJson(cwd, props);
}

export async function autoSetupKeystore(
  cwd: string,
  opts: AutoSetupKeystoreOpts = {}
): Promise<AutoSetupKeystoreResult> {
  const warnings: string[] = [];

  const existing = readKeystoreProps(cwd);
  if (existing) {
    return { provider: 'existing', storeFile: existing.storeFile, keyAlias: existing.keyAlias, warnings };
  }

  // 1. Rehydrate from credentials.json when a candidate is on disk.
  if (findRehydrateCandidate(cwd)) {
    try {
      await rehydrateFromCredentialsJson(cwd, opts.rehydrate);
      const props = readKeystoreProps(cwd)!;
      finalize(cwd, props);
      return { provider: 'rehydrate', storeFile: props.storeFile, keyAlias: props.keyAlias, warnings };
    } catch (err: any) {
      warnings.push(`Rehydrate failed: ${err?.message || err}`);
    }
  }

  // 2. Fetch from EAS when the project is linked and we have auth.
  const auth = opts.auth === undefined ? resolveEasAuth() : opts.auth;
  if (opts.projectId && auth) {
    try {
      const fetched = await fetchEasKeystore(cwd, opts.projectId, undefined, true, auth);
      const props = readKeystoreProps(cwd)!;
      finalize(cwd, props);
      return { provider: 'eas', storeFile: fetched.storeFile, keyAlias: fetched.keyAlias, warnings };
    } catch (err: any) {
      warnings.push(`EAS keystore fetch failed: ${err?.message || err}`);
    }
  }

  // 3. Generate locally — the fallback that always works when keytool exists.
  const auto = await autoGenerateKeystore(cwd, opts.generateParams);
  return {
    provider: 'generate',
    storeFile: auto.storeFile,
    keyAlias: auto.keyAlias,
    generatedPassword: auto.generatedPassword,
    params: auto.params,
    warnings,
  };
}

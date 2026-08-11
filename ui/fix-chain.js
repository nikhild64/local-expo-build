/**
 * Build-fix chain for the local UI (P0-1), extracted from app.js so the
 * decision logic is unit-testable without a browser (mirrors the CLI
 * pre-flight exports in src/commands/build.ts).
 *
 * UMD: loaded by ui/index.html as a plain <script> (attaches to
 * window.LocalExpoBuildFixChain), and required directly by Node tests via
 * module.exports. No DOM, fetch, or crypto access here — everything the chain
 * needs is injected through `deps`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LocalExpoBuildFixChain = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The smart Android package default doctor also uses: the project folder
   * name, lowercased and stripped to [a-z0-9] (falls back to "app").
   */
  function buildDefaultPackageName(folderName) {
    const clean =
      (folderName || 'app').toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';
    return `com.example.${clean}`;
  }

  /** Human-readable "missing" list for the confirm prompt. */
  function missingPartsLabel(needsPackage, needsKeystore) {
    const parts = [];
    if (needsPackage) parts.push('the Android package name');
    if (needsKeystore) parts.push('a release signing keystore');
    return parts.join(' and ');
  }

  /**
   * Runs the one-click Build & Fix chain and reports readiness.
   *
   * Order of operations:
   *   1. Confirm — declining cancels with { ready: false, cancelled: true }.
   *   2. Android package — POST /api/doctor/fix-package with the smart default.
   *   3. Release keystore — a single POST /api/keystore/auto-setup; the
   *      rehydrate → EAS fetch → generate decision runs server-side in
   *      src/core/keystore/autoSetup.ts (shared with the CLI). Local
   *      generation returns the shown-once password in `generatedPassword` so
   *      the caller can display it with a copy button.
   *
   * `deps`:
   *   confirm(message)            -> Promise<boolean>
   *   alert(title, message, type) -> Promise<void>
   *   api(url, options)           -> Promise<{ ok, data }>
   *   folderName                  -> string (project folder, for the default)
   *
   * Returns { ready, cancelled?, generatedPassword? }.
   */
  async function runFixChain({ needsPackage, needsKeystore }, deps) {
    // Nothing to fix — don't even prompt (same guard as the CLI pre-flight).
    if (!needsPackage && !needsKeystore) return { ready: true };

    const label = missingPartsLabel(needsPackage, needsKeystore);
    const confirmed = await deps.confirm(
      `This project is missing ${label}. Fix them automatically and start the build?`
    );
    if (!confirmed) return { ready: false, cancelled: true };

    // 1. Android package — apply the same smart default doctor suggests.
    if (needsPackage) {
      const defaultPkg = buildDefaultPackageName(deps.folderName);
      const { ok, data } = await deps.api('/api/doctor/fix-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName: defaultPkg }),
      });
      if (!ok) {
        await deps.alert(
          'Could not fix package name',
          (data && data.error) || 'Failed to set the Android package.',
          'error'
        );
        return { ready: false };
      }
    }

    // 2. Signing keystore — one call; the rehydrate/EAS/generate decision is
    // server-side (autoSetup.ts). The server returns the shown-once
    // `generatedPassword` (only for local generation) plus the storeFile /
    // keyAlias that landed, so the caller never hardcodes the file name.
    let generatedPassword = null;
    let storeFile = null;
    let keyAlias = null;
    if (needsKeystore) {
      const { ok, data } = await deps.api('/api/keystore/auto-setup', {
        method: 'POST',
      });
      if (!ok) {
        await deps.alert(
          'Could not set up keystore',
          (data && data.error) || 'Keystore setup failed.',
          'error'
        );
        return { ready: false };
      }
      if (data) {
        if (data.generatedPassword) generatedPassword = data.generatedPassword;
        storeFile = data.storeFile || null;
        keyAlias = data.keyAlias || null;
      }
    }

    return { ready: true, generatedPassword, storeFile, keyAlias };
  }

  return { runFixChain, buildDefaultPackageName, missingPartsLabel };
});

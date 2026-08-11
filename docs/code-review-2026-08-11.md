# Code Review — 2026-08-11

Scope: full pass over `src/` (CLI + UI server) and `ui/` (browser frontend), plus the
scaffolded `templates/scripts/*.js`. Baseline: `npm run test:only` → 77/77 pass.

Status: **findings only — fixes not yet implemented.** Each fix below is designed to
preserve the existing flows (no flow redesign).

---

## A. Confirmed bugs (code contradicts its own intent / README)

### A1. Generated keystore (`.p12`) never gitignored — security issue
- `src/core/keystore/index.ts:77` gitignores `['keystore.properties', '*.jks', 'credentials.json']` — **`*.p12` missing**. The early-return path at line 36 does include `*.p12`, so this is an inconsistency.
- `generateKeystore` defaults to `release.p12` and logs *"Backup → release.p12 (project root, gitignored)"* (`generate.ts:109`) — false claim.
- `src/commands/init.ts:105` and `src/core/scaffoldScripts.ts:147` also omit `*.p12`.
- **Impact:** a release keystore with plaintext passwords can be committed to git.
- **Fix:** add `'*.p12'` to all four gitignore lists. Zero flow change.

### A2. `doctor --fix` reports failure right after successfully fixing the Android package
- `src/commands/doctor.ts:915`: `replaceResultByName(results, 'Android package (applicationId)', …)` — the real row name is `'Android package (app.json)'` / `'Android package (app.config.*)'` (set in `androidPackageCheck`). Replace never matches → stale failing row stays + duplicate row appended → `failedCount` stays > 0 → `doctor` exits 1 even though the fix succeeded.
- **Fix:** use `androidPackageCheck(cwd).result.name` as the replace key. Preserves the fix-all flow.

### A3. `build ios` crashes at step 2/5 on iOS-only projects
- `src/commands/build.ts` calls `bumpVersion()`, which hard-throws when `android/app/build.gradle` is missing (`src/core/bumpVersion.ts:30`). `expo prebuild --platform ios` does not generate `android/`. README explicitly claims this step is a *"no-op on iOS-only builds"* — it isn't; it throws.
- **Fix:** make `bumpVersion` tolerate a missing gradle file (bump `app.json` only, log a dim note) or pass a flag from the iOS command to skip the gradle write.

### A4. `keystore import | create | fetch` silently no-op when a keystore is already configured
- `src/core/keystore/index.ts:28-35` — `ensureKeystore` returns early whenever `keystore.properties` exists, **ignoring `forceProvider`**. Users can't switch/replace a keystore via CLI; README-documented `keystore import <path>` silently does nothing.
- The UI server is NOT affected (it calls providers directly), so the UI already supports overwrite.
- **Fix:** let a forced provider bypass the early return (e.g. `importExistingKeystore` overwrites props), or add an `--overwrite` flag. `rehydrate` stays idempotent.

### A5. UI keystore flows never gitignore secrets (worse than A1)
- `src/server/server.ts` routes `/api/keystore/setup` (generate/import/rehydrate) and `/api/keystore/upload` call `generateKeystore` / `importExistingKeystore` / `rehydrateFromCredentialsJson` directly — **none of them call `ensureGitignoreEntries`**. Only `/api/keystore/fetch-eas` (via `fetchEasKeystore`) gitignores.
- **Impact:** via the UI, `keystore.properties`, `credentials.json`, and the `.jks`/`.p12` are all left un-ignored → committable secrets.
- **Fix:** call `ensureGitignoreEntries(cwd, ['keystore.properties', '*.jks', '*.p12', 'credentials.json'])` inside each keystore provider (generate/import/rehydrate) so both CLI and UI paths are covered, or add it to the server routes.

### A6. Auto-generated keystore password is never shown (fix-all flows)
- Both `runDoctor` fix-all (`src/commands/doctor.ts`, `generateKeystore` with random `pass`) and UI `fixAllDoctorIssues` (`ui/app.js`) generate `release.p12` with a random password and never display it. The user can't back it up or use it with `eas submit`.
- **Fix:** surface the generated password once in the success message/modal with a backup warning.

---

## B. Edge cases / hardening (not flow-breaking)

### B1. Version bump robustness (`src/core/bumpVersion.ts`, `templates/scripts/bump-version.js`)
- Non-numeric patch → `1.0.NaN` (e.g. `1.0.x`); pre-release versions (`1.0.0-rc.1`, 4 segments) throw a generic error; leading-zero patches (`1.0.07`) lose the zero.
- Fix: validate the patch segment is numeric before bumping; give a clearer error for pre-release versions.

### B2. credentials.json ↔ keystore.properties drift
- `src/core/setupSigning.ts` `ensureKeystoreInAndroidApp`: when only an alternate-extension keystore (`release.jks` vs configured `release.p12`) exists in `android/app/`, it rewrites `keystore.properties` to the alternate name but never `credentials.json` (still points at the old name → EAS submit breaks). Same in `templates/scripts/setup-signing.js`.
- Fix: re-sync `writeCredentialsJson` after the props swap.

### B3. `/api/status` and `/api/keystore/status` return plaintext keystore passwords
- Served over HTTP; CORS is granted to any `127.0.0.1`/`localhost` origin, so any page served from localhost can read them. Local-trust by design, but redacting password fields (like `--logs` redaction) is cheap.

### B4. UI-server shutdown mid-build
- Ctrl+C (`src/commands/ui.ts`) exits the process without aborting the running build → Gradle child killed mid-flight. Fix: `buildAbort?.abort()` in shutdown so the "Build stopped by user" path runs.

### B5. `collectDoctorChecks` 8s timeout race
- `Promise.race` returns a partial, misleadingly-green "Environment check timeout" row while real checks keep running in the background. Mark it incomplete or cancel the in-flight checks.

### B6. iOS multi-workspace error message
- `src/core/ios/detect.ts` returns null on 2+ workspaces; `src/commands/build.ts` says "pass --scheme to disambiguate", but `--scheme` cannot select a workspace (`workspacePath` is null → crash at step 4). Fix the message or add a `--workspace` flag.

### B7. Scaffolded `sync-eas-version.js` reads `build.gradle` before checking `projectId`
- Unlinked project without `android/` throws ENOENT instead of printing "skip EAS sync" (non-fatal only because `allowFail`). Check `projectId` first.

### B8. Template `build.js` prebuild omits `--non-interactive`
- The CLI runner passes it; the scaffolded script doesn't → scaffold-mode builds may hit interactive prompts the runner suppresses. Minor inconsistency.

### B9. `uploadLocalKeystoreToEas` defaults missing package to `com.example.app`
- `src/core/keystore/easApiFetch.ts` — silently registers the keystore under a placeholder application identifier on EAS. Require the package (doctor already gates it).

### B10. Keystore mutations allowed mid-build (UI)
- `/api/keystore/fetch-eas` guards with `activeBuild` (409), but `/api/keystore/setup` and `/api/keystore/upload` don't — the user can swap `keystore.properties` while a build is running (build stays consistent because it read props once, but the post-build state is confusing).

### B11. UI upload accepts `.p12` but server rejects it
- `ui/index.html` drop zone + `accept=".p12,.jks,.keystore"` vs server check allowing only `.jks`/`.keystore` (`src/server/server.ts`). Align the two.

### B12. Keystore upload uses temp-filename as storeFile
- Uploaded files land as `upload-<timestamp>-<basename>.jks`; `keystore.properties` storeFile becomes that name, and re-uploads pile up copies in `android/app/` + project root. Derive a stable name from the original filename.

### B13. `collectDoctorChecks`/doctor UI not affected by A2
- Confirmed: the UI doctor flow (`performDoctorChecks` + `/api/doctor/fix-package`) does not have the row-name mismatch; A2 is CLI-only. The UI's `fixAllDoctorIssues` shows correct capability-driven buttons.

---

## C. Fix plan (priority order)

1. **Security:** A1 + A5 (gitignore `*.p12` everywhere; ensure UI keystore routes/providers call `ensureGitignoreEntries`).
2. **Correctness:** A2 (doctor row key), A3 (iOS bump tolerance), A4 (CLI keystore overwrite), A6 (surface generated password).
3. **Hardening batch:** B1–B13 as individually small, self-contained fixes.
4. Add regression tests for A1–A6 and re-run `npm test` (baseline 77/77).

## D. Verification notes
- Findings verified against current code (exact call sites noted above).
- Existing tests do not exercise these paths — new tests required for A1–A6.
- No code changes were made during this review; all flows preserved.

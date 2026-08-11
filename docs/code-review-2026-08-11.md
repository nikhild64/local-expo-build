# Code Review — 2026-08-11

Scope: full pass over `src/` (CLI + UI server) and `ui/` (browser frontend), plus the
scaffolded `templates/scripts/*.js`. Baseline: `npm run test:only` → 77/77 pass.

Status: **all confirmed bugs (A1–A6) and all B-series hardening items (B1–B12) are
fixed and committed** (see commit history; each fix committed separately with a
relevant message). B13 was a verification note only. Each fix was designed to
preserve the existing flows (no flow redesign).

Round 2 (below, section D) covers the remaining un-reviewed areas
(`src/commands/ui.ts`, `src/server/*`, `src/util/*`) — findings D1–D12 are **filed**.
D1–D6 are **fixed and committed** with regression tests (D1–D3 confirmed bugs,
D4–D6 hardening); D7–D12 (minor) are still open.

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

### B1. ✅ FIXED — Version bump robustness (`src/core/bumpVersion.ts`, `templates/scripts/bump-version.js`)
- Non-numeric patch → `1.0.NaN` (e.g. `1.0.x`); pre-release versions (`1.0.0-rc.1`, 4 segments) throw a generic error; leading-zero patches (`1.0.07`) lose the zero.
- Fix: validate the patch segment is numeric before bumping; give a clearer error for pre-release versions.

### B2. ✅ FIXED — credentials.json ↔ keystore.properties drift
- `src/core/setupSigning.ts` `ensureKeystoreInAndroidApp`: when only an alternate-extension keystore (`release.jks` vs configured `release.p12`) exists in `android/app/`, it rewrites `keystore.properties` to the alternate name but never `credentials.json` (still points at the old name → EAS submit breaks). Same in `templates/scripts/setup-signing.js`.
- Fix: re-sync `writeCredentialsJson` after the props swap.

### B3. ✅ FIXED — `/api/status` and `/api/keystore/status` return plaintext keystore passwords
- Served over HTTP; CORS is granted to any `127.0.0.1`/`localhost` origin, so any page served from localhost can read them. Local-trust by design, but redacting password fields (like `--logs` redaction) is cheap.

### B4. ✅ FIXED — UI-server shutdown mid-build
- Ctrl+C (`src/commands/ui.ts`) exits the process without aborting the running build → Gradle child killed mid-flight. Fix: `buildAbort?.abort()` in shutdown so the "Build stopped by user" path runs.

### B5. ✅ FIXED — `collectDoctorChecks` 8s timeout race
- `Promise.race` returns a partial, misleadingly-green "Environment check timeout" row while real checks keep running in the background. Mark it incomplete or cancel the in-flight checks.

### B6. ✅ FIXED — iOS multi-workspace error message
- `src/core/ios/detect.ts` returns null on 2+ workspaces; `src/commands/build.ts` says "pass --scheme to disambiguate", but `--scheme` cannot select a workspace (`workspacePath` is null → crash at step 4). Fix the message or add a `--workspace` flag.

### B7. ✅ FIXED — Scaffolded `sync-eas-version.js` reads `build.gradle` before checking `projectId`
- Unlinked project without `android/` throws ENOENT instead of printing "skip EAS sync" (non-fatal only because `allowFail`). Check `projectId` first.

### B8. ✅ FIXED — Template `build.js` prebuild omits `--non-interactive`
- The CLI runner passes it; the scaffolded script doesn't → scaffold-mode builds may hit interactive prompts the runner suppresses. Minor inconsistency.

### B9. ✅ FIXED — `uploadLocalKeystoreToEas` defaults missing package to `com.example.app`
- `src/core/keystore/easApiFetch.ts` — silently registers the keystore under a placeholder application identifier on EAS. Require the package (doctor already gates it).

### B10. ✅ FIXED — Keystore mutations allowed mid-build (UI)
- `/api/keystore/fetch-eas` guards with `activeBuild` (409), but `/api/keystore/setup` and `/api/keystore/upload` don't — the user can swap `keystore.properties` while a build is running (build stays consistent because it read props once, but the post-build state is confusing).

### B11. ✅ FIXED — UI upload accepts `.p12` but server rejects it
- `ui/index.html` drop zone + `accept=".p12,.jks,.keystore"` vs server check allowing only `.jks`/`.keystore` (`src/server/server.ts`). Align the two.

### B12. ✅ FIXED — Keystore upload uses temp-filename as storeFile
- Uploaded files land as `upload-<timestamp>-<basename>.jks`; `keystore.properties` storeFile becomes that name, and re-uploads pile up copies in `android/app/` + project root. Derive a stable name from the original filename.

### B13. `collectDoctorChecks`/doctor UI not affected by A2
- Confirmed: the UI doctor flow (`performDoctorChecks` + `/api/doctor/fix-package`) does not have the row-name mismatch; A2 is CLI-only. The UI's `fixAllDoctorIssues` shows correct capability-driven buttons.

---

## D. Round 2 — remaining areas (`src/commands/ui.ts`, `src/server/*`, `src/util/*`)

### D1. ✅ FIXED — `keystore` subcommands ignore `--dry-run` and perform real writes
- `src/commands/keystore.ts` — all five subcommands destructure only `{ cwd }` from
  `getCtx(cmd)`; `dryRun` is discarded. `local-expo-build --dry-run keystore
  create|import|fetch|rehydrate|setup` runs keytool, copies files, and writes
  `keystore.properties` + `credentials.json` + `.gitignore` for real. Every other
  command (`build`, `init`, interactive `doctor`, `update-scripts`) honors dry-run.
- **Impact:** a dry-run that is supposed to print actions instead mutates the project
  (and can generate a keystore).
- **Fix:** at the command layer, when `ctx.dryRun` log the actions that would run and
  return (or pass `dryRun` down to the providers). Keeps the interactive flow intact.

### D2. ✅ FIXED — `doctor --fix --dry-run` executes destructive fixes
- `src/commands/doctor.ts` — `runAutoFixAll = fixAll === true` is **not** gated on
  `dryRun`, so `doctor --fix --dry-run` writes `expo.android.package` into app.json
  and auto-generates a keystore. The interactive path is correctly gated
  (`interactive = process.stdin.isTTY && !dryRun`), so only the CI/fix-all path is
  broken.
- **Fix:** `runAutoFixAll = fixAll === true && !dryRun` (print a dry-run notice when
  `--fix --dry-run`).

### D3. ✅ FIXED — Unwritable npm-registry cache dir crashes every CLI command
- `src/util/checkCliUpdate.ts` — `resolveLatestPublishedVersion()` calls `writeCache()`
  (`fs.mkdirSync` + `fs.writeFileSync` under `os.homedir()/.cache/…`) with no
  try/catch. `maybePromptCliUpdate` is awaited unguarded in the `cli.ts` preAction
  hook, so the throw propagates to `parseAsync().catch` → every command fails with
  `local-expo-build failed` and exit 1.
- **Reproduced live:** `USERPROFILE=<path-to-a-file> node dist/cli.js doctor --dry-run`
  → `Error: ENOTDIR … at writeCache` → command aborted. Same failure on read-only
  HOME (Nix, sandboxed CI, read-only filesystems). The registry fetch is already
  best-effort; the cache write must be too.
- **Fix:** wrap `writeCache()` in try/catch inside `resolveLatestPublishedVersion`.

### D4. ✅ FIXED — UI server can crash with unhandled EADDRINUSE
- `src/server/server.ts` — `findAvailablePort` probes a net server, then the real
  `http.createServer().listen()` runs with **no `'error'` listener** and the listen
  promise never rejects on failure. Two `ui` instances started together (probe+listen
  TOCTOU) or any bind race → unhandled `'error'` event → process crash.
  Corroborated by the EADDRINUSE-on-3999 flake seen in the test suite.
- **Fix:** add `server.on('error', …)` that rejects the listen promise (and/or retry
  the next port), so a busy port fails cleanly instead of crashing.

### D5. ✅ FIXED — Uploaded keystore temp file leaks on client abort
- `/api/keystore/upload` cleans `tmpPath` on busboy `'error'` and on every `'finish'`
  branch, but **not on premature request close** (client disconnects mid-upload). The
  file stays in `os.tmpdir()` forever.
- **Fix:** `req.on('close')` → if the upload didn't complete and `tmpPath` exists,
  unlink it.

### D6. ✅ FIXED — `--max-ram` clobbers the user's `GRADLE_OPTS` / `NODE_OPTIONS`
- `src/core/gradleRun.ts` and `src/core/prebuild.ts` — when `maxRam` is set, `env` is
  assigned wholesale (`env.GRADLE_OPTS = …`, `env.NODE_OPTIONS = …`), discarding
  project/user values (e.g. `NODE_OPTIONS=--openssl-legacy-provider` or custom Gradle
  args).
- **Fix:** append to existing values
  (`env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--max-old-space-size=…'].filter(Boolean).join(' ')`).

### D7. 🔸 MINOR — `parseRamMb` edge cases (`src/util/ram.ts`)
- `'0g'` / `'0m'` → `0` (falsy) → silently ignored with no message; no upper bound, so
  `999999g` flows into `-Xmx999998976m`. Validate `> 0` and cap (e.g. 64g) with a clear error.

### D8. 🔸 MINOR — Uploaded `storeFile` is not sanitized
- `/api/keystore/upload` registers the file under `path.basename(originalFilename)`;
  a name containing a single quote or other Groovy-breaking character breaks the
  injected `file('…')` signing config (build failure with a cryptic message).
  Sanitize to `[A-Za-z0-9._-]` or reject the upload.

### D9. 🔸 MINOR — Keystore-mutating routes aren't in the `withEasOperation` mutex
- `/api/keystore/setup` + `/api/keystore/upload` are guarded by `activeBuild` (B10)
  but not by `withEasOperation`; two concurrent keystore mutations can race on
  `keystore.properties` / `credentials.json`. Wrap them in the same mutex as the EAS
  operations.

### D10. 🔸 MINOR — Static-file read error is unhandled
- The ui/ static handler has no `'error'` handler on `fs.createReadStream`: if a file
  vanishes between `existsSync` and open, the stream error is unhandled → process
  crash. Add an error handler that 404s.

### D11. 🔸 MINOR — Hints hardcode `npx` while update-check detects the PM
- `maybePromptScriptUpdate.ts`, `doctor.ts` suggestions, and `update.ts` print
  `npx local-expo-build …`, but `checkCliUpdate` detects bun/pnpm/yarn/npm. Cosmetic
  inconsistency for non-npm users.

### D12. 🔸 MINOR — `redactLogLine` partial redaction
- `src/server/server.ts` `redactLogLine` only matches `key` + `=`/`:` + `\S+`;
  space-separated values (`storePassword mypass`) or quoted values with spaces are
  partially redacted or missed.

### Verified OK (do not "fix")
- `/api/keystore/upload` with missing passwords throws a clear error instead of
  hanging on a non-TTY prompt (verified `importExistingKeystore` params path).
- `maybePromptScriptUpdate` skip wiring is correct in `build.ts` / `doctor.ts`
  (`skip: ctx.skipUpdateCheck`).
- A3 fix holds: `bumpVersion` bumps app.json only when gradle is missing; writes
  gradle only when present. B2 fix holds: `ensureKeystoreInAndroidApp` re-syncs both
  `keystore.properties` and `credentials.json`.
- Static-file path-traversal guard is safe: `new URL().pathname` stays
  percent-encoded, so fs never sees decoded `..`; encoded traversal resolves to a
  non-existent name → index.html fallback.

---

## E. Fix plan — DONE

1. ✅ **Security:** A1 + A5 (gitignore `*.p12` everywhere; keystore providers call `ensureGitignoreEntries` for both CLI and UI paths).
2. ✅ **Correctness:** A2 (doctor row key), A3 (iOS bump tolerance), A4 (CLI keystore overwrite), A6 (surface generated password).
3. ✅ **Hardening batch:** B1–B12 (each committed separately; B13 was a verification note).
4. ✅ Regression tests for A1–A6 / B-series added (`test/bump-version.test.js`, `test/keystore.test.js`, extended `scaffold-scripts.test.js` and `ui-server.test.js`) — suite grew from 77 to 96 tests, all green. Writing them surfaced and fixed one more real bug in the upload route (a flush race + missing response on busboy errors).

## F. Verification notes
- Round 1 findings verified against current code (exact call sites noted above).
- Round 2 findings (D1–D12) verified against current code; D3 reproduced live.
- No code changes were made during this review; all flows preserved.

# Replace the Web Terminal with Direct EAS API Calls

## Summary

Remove the embedded xterm.js/PTY terminal from the UI and replace the three
allowlisted `eas` commands with real one-click buttons backed by direct calls to
Expo's GraphQL API (`https://api.expo.dev/graphql`) from the local server.

| Today (PTY) | After |
| --- | --- |
| "Run \`eas init\`" → spawns `eas init` in xterm | Button → project picker modal → writes `expo.extra.eas.projectId` |
| "Run \`eas build:configure\`" → spawns in xterm | Button → writes `eas.json` locally (no network) |
| "Launch \`eas credentials\` in Web Terminal" → user drives a menu, downloads `.jks`, re-runs `keystore import` | Button → fetches base64 JKS + passwords → writes `android/app/<file>` + `keystore.properties` + `credentials.json` |

Deletions: [ptyServer.ts](file:///d:/Projects/expo/expo-local-build/src/server/ptyServer.ts),
the `/pty` WebSocket upgrade handler, the `ws` dependency, the
`@lydell/node-pty` optional dependency, and [ui/vendor](file:///d:/Projects/expo/expo-local-build/ui/vendor)
(xterm.js + addon + css, ~1 MB shipped in the npm tarball).

### Why this is possible

Verified against the live API during exploration:

- `~/.expo/state.json` → `auth.sessionSecret`, sent as the `expo-session` header,
  authenticates successfully. `EXPO_TOKEN` as `Bearer` also works. This is
  exactly what [syncEasVersion.ts](file:///d:/Projects/expo/expo-local-build/src/core/syncEasVersion.ts#L9-L21)
  already does — the auth + `https.request` pattern is proven in this codebase.
- `account.byName(accountName:).apps(limit:offset:)` lists projects.
- `AppMutation.createApp(appInput: { accountId, projectName })` creates one.
- `app.byId(appId:).androidAppCredentials[].androidAppBuildCredentialsList[].androidKeystore`
  exposes `keystore` (base64), `keystorePassword`, `keyAlias`, `keyPassword`,
  `type`, `md5CertificateFingerprint`. Confirmed: returned a 2928-char base64
  blob plus both passwords for a real project.
- `AndroidKeystoreType` enum is `JKS | PKCS12 | UNKNOWN`.
- `eas build:configure` performs **no** network calls — it only writes `eas.json`.

### Non-goals

- No interactive login. If there's no session and no `EXPO_TOKEN`, the UI asks
  for a pasted access token. We do not reimplement `eas login`/OTP.
- iOS credentials stay out of scope.
- The CLI's existing interactive `execa`-based flows in
  [doctor.ts](file:///d:/Projects/expo/expo-local-build/src/commands/doctor.ts#L828-L886)
  and [easFetch.ts](file:///d:/Projects/expo/expo-local-build/src/core/keystore/easFetch.ts)
  are left alone — a TTY is the right place for a TTY. Only the browser UI changes.

---

## Current State Analysis

**Server** — [server.ts](file:///d:/Projects/expo/expo-local-build/src/server/server.ts)
is a plain `http.createServer` with hand-rolled routing on
`pathname` + `req.method`, an SSE broadcaster (`broadcastSse`), a localhost-only
CORS guard, and Busboy for multipart. `close()` tears down SSE clients, the PTY,
WS clients, and open sockets. `WebSocketServer` is attached at
[L394-L424](file:///d:/Projects/expo/expo-local-build/src/server/server.ts#L394-L424).

**PTY** — [ptyServer.ts](file:///d:/Projects/expo/expo-local-build/src/server/ptyServer.ts)
holds `ALLOWLISTED_COMMANDS` (`eas-init`, `eas-configure`, `eas-credentials`)
and spawns them via an optionally-present native module.

**Client** — [app.js](file:///d:/Projects/expo/expo-local-build/ui/app.js) is a
single IIFE, no framework. It already has a good `showModal`/`showAlert`/`showPrompt`
system at [L72-L159](file:///d:/Projects/expo/expo-local-build/ui/app.js#L72-L159)
— but `showModal` only supports a **single text input**, so the project picker
needs a new variant. `openPtyAndRun` is called from three places
([L417](file:///d:/Projects/expo/expo-local-build/ui/app.js#L417),
[L421](file:///d:/Projects/expo/expo-local-build/ui/app.js#L421),
[L655](file:///d:/Projects/expo/expo-local-build/ui/app.js#L655)).

**Reusable pieces we should not duplicate:**

- [writeKeystoreProps](file:///d:/Projects/expo/expo-local-build/src/core/setupSigning.ts#L107-L115) — writes `keystore.properties`.
- [writeCredentialsJson](file:///d:/Projects/expo/expo-local-build/src/core/writeCredentialsJson.ts#L21-L48) — merges, preserving any `ios` block.
- [ensureGitignoreEntries](file:///d:/Projects/expo/expo-local-build/src/util/gitignore.ts#L5-L15) — must be called so the fetched `.jks` and plaintext passwords never get committed.
- [invalidateExpoConfigCache](file:///d:/Projects/expo/expo-local-build/src/core/expoConfig.ts#L68-L71) — **critical**; `readExpoConfig` caches per-process and the UI server is long-lived, so any `app.json` write must invalidate or `/api/doctor` will serve stale state. [setAndroidPackage](file:///d:/Projects/expo/expo-local-build/src/commands/doctor.ts#L479-L501) is the reference pattern.
- [detectEasLink](file:///d:/Projects/expo/expo-local-build/src/core/easLink.ts#L19-L48) / `isEasReady` — drives the doctor capability flags.

**Constraint discovered:** `detectEasLink` returns `dynamic-unreadable` when
`app.config.js` exists but Expo CLI can't resolve it, and `source: 'dynamic'`
when it can. We must **never** write `app.json` when the effective config source
is dynamic — the value would be silently overridden by the dynamic config, and
the user would see the write "succeed" then have nothing change. This mirrors the
existing guard in [offerAndroidPackageFix](file:///d:/Projects/expo/expo-local-build/src/commands/doctor.ts#L371-L374).

---

## Proposed Changes

### 1. New: `src/core/eas/api.ts` — thin GraphQL client

**Why:** every following step needs authenticated GraphQL. The
`https.request` + auth-header logic in
[syncEasVersion.ts](file:///d:/Projects/expo/expo-local-build/src/core/syncEasVersion.ts#L9-L96)
is exactly this, but inlined and unreusable.

```ts
export type EasAuth = { sessionSecret: string } | { token: string };
export function resolveEasAuth(): EasAuth | null;   // EXPO_TOKEN → ~/.expo/state.json → null
export class EasApiError extends Error {
  code?: string;        // extensions.errorCode, e.g. EXPERIENCE_NOT_FOUND
  status?: number;
  isAuthError: boolean; // 401/403, or a null viewer
}
export async function easGraphql<T>(query: string, variables?: object, auth?: EasAuth): Promise<T>;
```

Behavior:

- `Content-Type: application/json`, `Content-Length`, and the same
  `expo-client-info` header `syncEasVersion` sends. Auth via `expo-session` or
  `Bearer`.
- 20 s timeout via `req.setTimeout` → reject `EasApiError`. Without this a hung
  socket leaves the UI spinner stuck forever.
- Cap the response body at ~10 MB and destroy the request beyond that.
- **Non-obvious:** the API returns HTTP **200** with a top-level `errors` array
  for most failures, and an invalid session yields `{ data: { viewer: null } }`
  — *not* a 401 (verified). So error detection must inspect the body, not just
  the status code. Surface `extensions.errorCode` as `code`.
- Never log the response body — keystore payloads and passwords flow through here.

Then refactor `syncEasVersion` to call `easGraphql`, deleting its private
`getSessionSecret` and inline `https.request`. Its current behavior (warn +
skip when no `projectId`) is preserved.

### 2. New: `src/core/eas/link.ts` — replaces `eas init`

```ts
export interface EasAccount { id: string; name: string }
export interface EasProject { id: string; name: string; slug: string; fullName: string }
export async function listAccounts(): Promise<EasAccount[]>;
export async function listProjects(accountName: string): Promise<EasProject[]>;
export async function createProject(accountId: string, projectName: string): Promise<EasProject>;
export function writeProjectIdToAppJson(cwd: string, projectId: string): void;
```

- `listAccounts` → `{ viewer { id username accounts { id name } } }`. A null
  `viewer` means the session is stale → throw an auth-flagged error.
- `listProjects` → `account.byName(accountName:){ apps(limit: 100, offset: 0) }`.
  100 is a deliberate cap; users with more can type a project ID manually.
- `writeProjectIdToAppJson` sets `expo.extra.eas.projectId`, preserving all
  other keys, writing `JSON.stringify(json, null, 2) + '\n'` and calling
  `invalidateExpoConfigCache(cwd)` — matching `setAndroidPackage` exactly.

Edge cases:
- `app.json` missing → create it with a minimal `{ expo: { name, slug } }`
  derived from `package.json`'s `name`, since `eas init` would also need a slug.
- `app.json` malformed → throw with the parse error; never overwrite.
- Already linked to a **different** `projectId` → do not silently clobber.
  Return a `409` so the UI can confirm re-link explicitly.
- `projectName` must be validated client- and server-side against
  `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` (Expo slug rules) before hitting `createApp`.
- Duplicate name → `createApp` errors; map to a readable "a project named X
  already exists in this account — pick it from the list instead".

### 3. New: `src/core/eas/configure.ts` — replaces `eas build:configure`

Pure local file write, no network.

```ts
export function writeEasJson(cwd: string): { created: boolean; path: string };
```

Writes, only when `eas.json` is absent:

```json
{
  "cli": { "version": ">= 3.0.0", "appVersionSource": "remote" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": { "autoIncrement": true }
  },
  "submit": { "production": {} }
}
```

`appVersionSource: "remote"` is deliberate — it's what makes
[syncEasVersion](file:///d:/Projects/expo/expo-local-build/src/core/syncEasVersion.ts)
authoritative, which is this tool's whole versioning model.

Edge case: if `eas.json` already exists, return `{ created: false }` and leave
it untouched. Never merge into or reformat a user's existing `eas.json` — build
profiles are hand-tuned and clobbering them is unrecoverable.

### 4. New: `src/core/keystore/easApiFetch.ts` — the real win

```ts
export interface EasKeystoreSummary {
  buildCredentialsId: string; name: string; isDefault: boolean;
  keyAlias: string; type: 'JKS' | 'PKCS12' | 'UNKNOWN';
  md5Fingerprint?: string; applicationIdentifier?: string;
}
export async function listEasKeystores(projectId: string): Promise<EasKeystoreSummary[]>;
export async function fetchEasKeystore(
  cwd: string,
  projectId: string,
  buildCredentialsId?: string   // default → the isDefault entry
): Promise<{ storeFile: string; keyAlias: string }>;
```

`fetchEasKeystore`:

1. Query `keystore` / `keystorePassword` / `keyAlias` / `keyPassword` / `type`.
2. `Buffer.from(base64, 'base64')`. **Validate before writing**: reject if
   empty, and require the JKS magic bytes `FE ED FE ED` (or PKCS12's `30 82`
   DER prefix). Guards against writing a truncated/garbage file that then fails
   deep inside Gradle with an unreadable error.
3. Filename `release.jks` (`release.p12` when `type === 'PKCS12'`).
4. Write to `android/app/<storeFile>`, `mkdir -p` first, **and** a project-root
   backup — [ensureKeystoreInAndroidApp](file:///d:/Projects/expo/expo-local-build/src/core/setupSigning.ts#L23-L70)
   depends on that root copy to survive `expo prebuild --clean` wiping `android/`.
   Same two-location pattern as
   [importExistingKeystore](file:///d:/Projects/expo/expo-local-build/src/core/keystore/existing.ts#L161-L172).
5. `ensureGitignoreEntries(cwd, ['keystore.properties', '*.jks', 'credentials.json'])`
   **before** writing secrets, so a `git add` between steps can't catch them.
   Add `*.p12` when applicable.
6. `writeKeystoreProps` then `writeCredentialsJson`.

Edge cases:
- Project not linked → throw before any network call.
- `androidAppCredentials` empty, or `androidAppBuildCredentialsList` empty →
  "EAS has no Android keystore for this project yet." (`eas credentials` would
  normally generate one; we surface a clear message rather than silently
  creating remote state.)
- Multiple build credentials → return the `isDefault` one; the UI lists all so
  the user can choose. Verified real projects do carry `isDefault: true`.
- `androidKeystore` present but `keystore` null → the account lacks read
  permission on the secret; explain rather than crash.
- `keyPassword` null → fall back to `keystorePassword` (mirrors the existing
  `keyPassword || storePassword` convention in `importExistingKeystore`).
- Overwriting an existing keystore → require an explicit `overwrite: true`
  from the UI; otherwise `409`. Silently replacing a signing key is how people
  lose the ability to ship updates to an existing Play listing.
- `type: 'UNKNOWN'` → warn but proceed using the magic-byte sniff.

### 5. `src/server/server.ts` — new routes, PTY removed

Remove: the `PtyManager` import + instance, `ptyAvailable` from `/api/status`,
the `WebSocketServer`, the `server.on('upgrade')` handler, and the WS/PTY
branches of `close()`. Keep the SSE, socket, and `server.close()` teardown.

New endpoints (following the file's existing `req.method`/`pathname` +
`parseJsonBody` style):

| Route | Behavior |
| --- | --- |
| `GET /api/eas/auth` | `{ authenticated, username?, accounts?, source: 'token' \| 'session' \| 'none' }`. Never returns the secret. |
| `POST /api/eas/auth` | Body `{ token }`. Validates via `viewer`, then holds it **in server memory only** for this process. Rejects with 401 if invalid. |
| `GET /api/eas/projects?account=<name>` | Project list for the picker. |
| `POST /api/eas/link` | `{ projectId }` or `{ accountId, projectName }` → create-then-link. Broadcasts `doctor-updated`. |
| `POST /api/eas/configure` | Writes `eas.json`. Broadcasts `doctor-updated`. |
| `GET /api/eas/keystores` | Keystore summaries for the linked project. No secrets — alias/fingerprint/type only. |
| `POST /api/keystore/fetch-eas` | `{ buildCredentialsId?, overwrite? }` → full fetch+write. Broadcasts `keystore-updated`. |

Cross-cutting rules:

- **Guard `app.json` writes on config source.** If `readExpoConfig(cwd).source === 'dynamic'`
  or the state is `dynamic-unreadable`, `POST /api/eas/link` returns `409` with
  the exact snippet to paste into `app.config.js` instead of writing a file that
  would have no effect.
- **A single in-flight mutex** shared by `link` / `configure` / `fetch-eas`,
  same shape as the existing `activeBuild` guard → `409` on concurrent calls.
  Two parallel keystore fetches would interleave writes to the same paths.
- **Reject `fetch-eas` while `activeBuild` is set** — swapping the keystore
  mid-build produces a corrupt or wrongly-signed artifact.
- **Never** put `keystorePassword`, `keyPassword`, the base64 blob, or the pasted
  token into an SSE `log`/`step` event or an HTTP response body. Responses carry
  only `{ success, storeFile, keyAlias }`. This preserves the
  server-side-only secret boundary the current keystore flow already has.
- Map `EasApiError.isAuthError` → HTTP `401` so the client can show the
  token prompt instead of a generic red banner.

### 6. `ui/index.html` + `ui/app.js` + `ui/styles.css`

**index.html:** delete the `#terminal-dock` block
([L286-L302](file:///d:/Projects/expo/expo-local-build/ui/index.html#L286-L302)),
the two `vendor/xterm*.js` script tags, and the `vendor/xterm.css` link. Rewrite
the EAS subpanel ([L274-L280](file:///d:/Projects/expo/expo-local-build/ui/index.html#L274-L280))
into a status area + keystore-selection list + a "Fetch Keystore from EAS"
button. Relabel the doctor buttons to "Link EAS Project" and "Create eas.json"
— the current backtick-command labels are the thing that leaks CLI mechanics
into the UI. Add an "EAS Account" card with the token-paste form (hidden when
already authenticated).

**app.js:** delete `term`/`fitAddon`/`ptyWs`/`ptyConnected`, `setupTerminalDock`,
`ensureTerminalInitialized`, `openPtyAndRun`, `connectPtyWebSocket`, and the
`pty-exit` SSE listener. Add `showChoiceModal({ title, message, options })`
extending the existing modal (the current one only does one text input) for the
project and keystore pickers. Wire the three buttons to the new endpoints; on
`401`, prompt for a token, then retry the original action once.

**styles.css:** remove `.terminal-dock`, `.dock-*`, `.pty-status-text`,
`#terminal-container`.

**Delete** [ui/vendor/](file:///d:/Projects/expo/expo-local-build/ui/vendor/)
(`xterm.js`, `xterm-addon-fit.js`, `xterm.css`).

### 7. `package.json`

- Drop `optionalDependencies.@lydell/node-pty`.
- Drop `dependencies.ws` and `devDependencies.@types/ws` — `/pty` was the only
  consumer (SSE is plain HTTP).
- Refresh `package-lock.json`.

### 8. Docs

- [README.md](file:///d:/Projects/expo/expo-local-build/README.md#L131) — replace
  the "Embedded Web Terminal" bullet with one-click EAS actions; note
  `EXPO_TOKEN` / `eas login` / pasted-token as the three auth paths.
- [README.md](file:///d:/Projects/expo/expo-local-build/README.md#L88) — update
  the `ui` command description (drop "embedded PTY").
- [CHANGELOG.md](file:///d:/Projects/expo/expo-local-build/CHANGELOG.md) — new
  entry: PTY/xterm removed, `ws` + `node-pty` dropped, one-click EAS actions,
  one-click keystore fetch. Call out that `keystore fetch` in the **browser UI**
  no longer needs the manual download → `keystore import` round-trip.
- [ui.ts](file:///d:/Projects/expo/expo-local-build/src/commands/ui.ts#L21) —
  the `--help` description still says "embedded web terminal".

### 9. Tests — `test/ui-server.test.js`

- Delete the `PTY Command Allowlist` describe block
  ([L88-L101](file:///d:/Projects/expo/expo-local-build/test/ui-server.test.js#L88-L101))
  and the `ptyServer.js` require.
- `GET /api/eas/auth` returns 200 and a boolean `authenticated` (must pass on
  CI where no session exists — assert the shape, not the value).
- `POST /api/eas/configure` on a temp project creates `eas.json` with
  `cli.appVersionSource === 'remote'`; a second call returns `created: false`
  and leaves the file byte-identical.
- `POST /api/eas/link` with no body → 400.
- `POST /api/keystore/fetch-eas` on an unlinked project → 409 with a message
  naming the missing link, **without** any network call.
- Unit-test `writeProjectIdToAppJson` preserves sibling `expo` keys.
- New `test/eas-api.test.js`: `resolveEasAuth` prefers `EXPO_TOKEN` over
  `state.json` and returns `null` when neither exists; the magic-byte validator
  accepts `FE ED FE ED`, accepts a `30 82` PKCS12 prefix, and rejects empty /
  garbage buffers.

No test may perform a real network call — CI has no Expo session.

---

## Assumptions & Decisions

1. **Direct GraphQL, not `execa` + `--non-interactive`.** True one-click UX, no
   `eas-cli` install required, and it's the only way to get a hands-off keystore
   fetch (no non-interactive export exists). Accepted risk: the schema is
   undocumented and unversioned. Mitigated by narrow queries, `errorCode`-based
   messages, and the CLI keeping its `eas`-shelling path as the escape hatch.
2. **Auth is read-only + paste-in.** `EXPO_TOKEN` → `~/.expo/state.json` →
   user-pasted token. No login reimplementation.
3. **Pasted tokens live in memory only.** Never written to `~/.expo/state.json`
   or any project file, and gone on server exit. Persisting another copy of a
   long-lived credential to disk isn't ours to decide for the user.
4. **`eas.json` is create-only.** Never merged or reformatted.
5. **`app.json` writes are refused for dynamic configs** — with the snippet to
   paste, instead of a write that appears to work but doesn't.
6. **Keystore overwrite is opt-in** via explicit confirmation.
7. **`localhost`-only + no-auth server is unchanged.** Out of scope here, but
   worth noting the net effect: removing `/pty` deletes an unauthenticated
   process-spawn surface where the allowlist was the only guard.
8. **CLI interactive flows unchanged.** `easFetch.ts` and `doctor.ts` keep
   shelling out to `eas`; only the browser UI switches to the API.

## Verification

1. `npm run build` — clean tsc.
2. `npm test` — all pass, including the new cases.
3. `npx local-expo-build ui` against a real Expo project:
   - Terminal dock is gone; no `xterm`/`vendor` requests in the network panel.
   - EAS card shows the logged-in username.
   - "Link EAS Project" lists real projects; picking one writes
     `expo.extra.eas.projectId`; Doctor auto-refreshes to `linked` via SSE.
   - "Create eas.json" writes the file; clicking again is a no-op.
   - "Fetch Keystore from EAS" produces `android/app/release.jks` +
     project-root backup + `keystore.properties` + `credentials.json`;
     `keytool -list -keystore android/app/release.jks` opens with the written
     password and shows the expected alias.
   - A build started right after succeeds and the APK/AAB is signed with that key.
4. Negative paths: unset `EXPO_TOKEN` and move `~/.expo/state.json` aside →
   every EAS action returns 401 and the UI prompts for a token; pasting an
   invalid one shows a clear error; a valid one unblocks and the retried action
   completes.
5. `app.config.js`-only project → "Link EAS Project" returns the 409 + paste
   snippet, and `app.json` is not created.
6. Confirm no secret leaks: with DevTools open through a full fetch, no
   response body or SSE frame contains a password or the base64 blob.
7. `npm pack --dry-run` — `ui/vendor/` absent, tarball meaningfully smaller.
8. Fresh `npm install` in a clean dir — no native build step, no `node-pty`.

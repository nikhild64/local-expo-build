# Contributing to local-expo-build

Thanks for your interest! This is a small focused CLI — happy to take PRs that
keep it that way.

## Dev setup

```bash
git clone https://github.com/nikhild64/local-expo-build.git
cd local-expo-build
npm install
npm run dev      # tsc --watch into dist/
```

To exercise your changes against a real Expo project:

```bash
cd <some-expo-app>
node /absolute/path/to/local-expo-build/bin/local-expo-build.js doctor
# or
npm link /absolute/path/to/local-expo-build
npx local-expo-build doctor
```

See the "Test your CLI locally in another Expo app" notes in the README for
the three iteration loops (`npm link`, `npm pack`, direct invocation).

## Code layout

```
src/
  cli.ts                       commander entry point
  commands/
    init.ts                    scaffold pipeline + pre-flight doctor
    build.ts                   runner-mode end-to-end build
    doctor.ts                  env checks + auto-fix wizard (exports runDoctor)
    keystore.ts                keystore subcommand surface
  core/
    sdkDetect.ts               read Expo SDK from package.json
    pinGradle.ts               SDK -> Gradle wrapper version table
    bumpVersion.ts             EAS versionCode fetch + app.json bump
    setupSigning.ts            inject release signingConfig + .jks recovery
    syncEasVersion.ts          push versionCode to EAS via GraphQL
    writeCredentialsJson.ts    scaffold credentials.json from keystore.properties
    easLink.ts                 detect EAS link state (projectId + eas.json)
    keystore/
      index.ts                 ensureKeystore + provider picker
      existing.ts              import a user-supplied .jks
      generate.ts              keytool -genkeypair wrapper
      easFetch.ts              eas credentials hand-off + pre-flight
      rehydrate.ts             bind credentials.json + .jks -> keystore.properties
  util/{log,ctx,gitignore}.ts
templates/                     scaffold-mode payloads copied into user projects
```

## Conventions

- **Two execution paths must stay in sync.** Anything in `src/core/` that runs
  during a build also has a templated counterpart in `templates/scripts/`
  (run by users in scaffold mode). When you change one, mirror the other.
- **Doctor never throws.** `runDoctor` returns `{ results, failedCount }`. The
  command wrapper decides whether to `process.exit(1)`. Callers (e.g. `init`)
  can present their own continue-or-abort UX.
- **Auto-fix offers gate on TTY + `--dry-run`.** Anything interactive must
  skip in non-TTY (CI) and dry-run mode, with a clear "run X manually"
  fallback message.
- **Mutate `results` in place after a successful auto-fix.** Use
  `replaceResultByName` so the final exit reflects what got fixed.
- **No comments that just narrate code.** Only document non-obvious
  intent / trade-offs.

## Adding a new doctor check

1. Add a check helper that returns `CheckResult` (or a richer struct with the
   raw state, so other helpers can consume it).
2. Push the row into `results` inside `runDoctor` in the existing order
   (env first, then project state, then keystore state).
3. If the check has a remediation, add a branch to `buildSuggestions`.
4. If the remediation is safe to automate, add an interactive offer in
   `runDoctor` (gated on TTY + `--dry-run`) and update the row in place via
   `replaceResultByName` after success.

## Adding Gradle pin for a new Expo SDK

Edit the `GRADLE_PIN` table in `src/core/pinGradle.ts`. Each row maps SDK
major to a Gradle wrapper version (or `null` for no-op). Open a PR if the new
pin works around an upstream bug — include a link to the issue.

## Reporting bugs

Please include:

- `npx local-expo-build doctor` output (sanitized — passwords are gitignored
  but copy carefully anyway).
- Node / JDK / `eas-cli` versions.
- The exact command + flags you ran.
- The error message, including the Gradle `--stacktrace` output if it's a
  build-time failure.

## License

By contributing you agree your work is released under the MIT license (see
`LICENSE`).

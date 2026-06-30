import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { Command } from 'commander';
import kleur from 'kleur';
import { confirm, input } from '@inquirer/prompts';
import { getCtx } from '../util/ctx';
import { log } from '../util/log';
import { projectBinExecArgs, resolveProjectBin } from '../util/resolveProjectBin';
import { maybePromptScriptUpdate } from '../util/maybePromptScriptUpdate';
import { compareScripts } from '../core/scaffoldScripts';
import { detectExpoSdk } from '../core/sdkDetect';
import { GRADLE_PIN } from '../core/pinGradle';
import { detectEasLink, EasLinkResult } from '../core/easLink';
import { readKeystoreProps, KeystoreProps } from '../core/setupSigning';
import { ensureKeystore } from '../core/keystore';
import { findRehydrateCandidate } from '../core/keystore/rehydrate';
import { readExpoConfig, invalidateExpoConfigCache } from '../core/expoConfig';

type CheckResult = { name: string; ok: boolean; detail?: string; warn?: boolean };

interface KeystorePropsCheck {
  result: CheckResult;
  props: KeystoreProps | null;
  fileExists: boolean;
}

interface CredentialsJsonCheck {
  result: CheckResult;
  exists: boolean;
  valid: boolean;
}

interface AndroidPackageCheck {
  result: CheckResult;
  pkg: string | null;
  source: 'app.json' | 'dynamic' | 'dynamic-unreadable' | 'none';
}

function replaceResultByName(results: CheckResult[], name: string, newRow: CheckResult): void {
  const i = results.findIndex((r) => r.name === name);
  if (i !== -1) results[i] = newRow;
  else results.push(newRow);
}

async function which(cmd: string, args: string[] = ['-version']): Promise<string | null> {
  try {
    const { stdout, stderr } = await execa(cmd, args, { reject: false, timeout: 10_000 });
    return (stdout || stderr || '').split('\n')[0]?.trim() || cmd;
  } catch {
    return null;
  }
}

async function projectBinVersion(name: string, cwd: string): Promise<string | null> {
  const bin = resolveProjectBin(name, cwd);
  if (!bin) return null;
  const { command, args, execa: execaOpts } = projectBinExecArgs(bin, ['--version']);
  try {
    const { stdout, stderr } = await execa(command, args, {
      cwd,
      reject: false,
      timeout: 10_000,
      ...execaOpts,
    });
    return (stdout || stderr || '').split('\n')[0]?.trim() || name;
  } catch {
    return null;
  }
}

function easLinkCheck(easLink: EasLinkResult): CheckResult {
  switch (easLink.kind) {
    case 'linked':
      return easLink.hasEasJson
        ? { name: 'EAS project linked', ok: true, detail: easLink.projectId }
        : {
            name: 'EAS project linked',
            ok: true,
            warn: true,
            detail: `${easLink.projectId} — but eas.json missing; run \`eas build:configure -p android\``,
          };
    case 'not-linked':
      return {
        name: 'EAS project linked',
        ok: true,
        warn: true,
        detail: easLink.hasAppJson
          ? 'no expo.extra.eas.projectId — run `eas init` for managed JKS'
          : 'no app.json — run `eas init` to link this project',
      };
    case 'dynamic-unreadable':
      return {
        name: 'EAS project linked',
        ok: true,
        warn: true,
        detail: easLink.hasEasJson
          ? "app.config.* couldn't be resolved — run `npm install` in this project"
          : "app.config.* couldn't be resolved + no eas.json — run `npm install` then re-run doctor",
      };
    case 'no-expo-config':
      return {
        name: 'EAS project linked',
        ok: true,
        warn: true,
        detail: 'skipped (no app.json or app.config.*)',
      };
  }
}

// Loose Android applicationId validator: lower-case Java package style.
// Real Android rules: each segment starts with a letter, only letters/digits/underscore,
// at least two segments. Gradle is the authoritative checker — we just flag obvious typos.
const ANDROID_PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function androidPackageCheck(cwd: string): AndroidPackageCheck {
  const resolved = readExpoConfig(cwd);
  const hasDynamicConfig =
    fs.existsSync(path.join(cwd, 'app.config.js')) ||
    fs.existsSync(path.join(cwd, 'app.config.ts')) ||
    fs.existsSync(path.join(cwd, 'app.config.cjs')) ||
    fs.existsSync(path.join(cwd, 'app.config.mjs'));

  if (resolved) {
    const pkg: string | undefined = resolved.config?.android?.package;
    const rowName =
      resolved.source === 'app.json' ? 'Android package (app.json)' : 'Android package (app.config.*)';
    const source = resolved.source === 'app.json' ? 'app.json' : 'dynamic';
    if (!pkg) {
      return {
        result: {
          name: rowName,
          ok: false,
          detail: 'missing expo.android.package — Gradle and EAS sync will fail',
        },
        pkg: null,
        source,
      };
    }
    if (!ANDROID_PKG_RE.test(pkg)) {
      return {
        result: {
          name: rowName,
          ok: false,
          detail: `"${pkg}" is not a valid Android applicationId (need at least two dot-separated segments)`,
        },
        pkg,
        source,
      };
    }
    return {
      result: { name: rowName, ok: true, detail: pkg },
      pkg,
      source,
    };
  }

  if (hasDynamicConfig) {
    return {
      result: {
        name: 'Android package (app.config.*)',
        ok: true,
        warn: true,
        detail: "app.config.* couldn't be resolved — run `npm install` in this project",
      },
      pkg: null,
      source: 'dynamic-unreadable',
    };
  }

  return {
    result: {
      name: 'Android package (app.json)',
      ok: false,
      detail: 'no app.json or app.config.* — is this an Expo project?',
    },
    pkg: null,
    source: 'none',
  };
}

function keystorePropsCheck(cwd: string): KeystorePropsCheck {
  const propsPath = path.join(cwd, 'keystore.properties');
  const fileExists = fs.existsSync(propsPath);
  if (!fileExists) {
    return {
      result: {
        name: 'keystore.properties',
        ok: true,
        warn: true,
        detail: 'not present — run `keystore setup` to create',
      },
      props: null,
      fileExists,
    };
  }
  const props = readKeystoreProps(cwd);
  if (!props) {
    return {
      result: {
        name: 'keystore.properties',
        ok: true,
        warn: true,
        detail: 'present but incomplete (FILL_IN or missing fields)',
      },
      props: null,
      fileExists,
    };
  }
  return {
    result: {
      name: 'keystore.properties',
      ok: true,
      detail: `storeFile=${props.storeFile}, alias=${props.keyAlias}`,
    },
    props,
    fileExists,
  };
}

function jksCheck(cwd: string, props: KeystoreProps | null): CheckResult {
  if (!props) {
    // No keystore.properties — but if credentials.json + a real .jks exist,
    // that's a recoverable state via `keystore rehydrate`.
    const cand = findRehydrateCandidate(cwd);
    if (cand) {
      const rel = path.relative(cwd, cand.jksSourceAbs).replace(/\\/g, '/');
      return {
        name: 'Signing keystore (.jks)',
        ok: true,
        warn: true,
        detail: `found ${rel} via credentials.json — run \`keystore rehydrate\` to bind it`,
      };
    }
    return {
      name: 'Signing keystore (.jks)',
      ok: true,
      warn: true,
      detail: 'skipped (no valid keystore.properties)',
    };
  }
  const jksPath = path.join(cwd, 'android', 'app', props.storeFile);
  const rel = path.relative(cwd, jksPath).replace(/\\/g, '/');
  if (!fs.existsSync(jksPath)) {
    return {
      name: 'Signing keystore (.jks)',
      ok: true,
      warn: true,
      detail: `not found at ${rel} — run \`keystore create|import|fetch|rehydrate\``,
    };
  }
  const stat = fs.statSync(jksPath);
  if (stat.size === 0) {
    return { name: 'Signing keystore (.jks)', ok: true, warn: true, detail: `${rel} is empty` };
  }
  return { name: 'Signing keystore (.jks)', ok: true, detail: `${rel} (${(stat.size / 1024).toFixed(1)} KB)` };
}

function credentialsJsonCheck(
  cwd: string,
  props: KeystoreProps | null,
  easLink: EasLinkResult
): CredentialsJsonCheck {
  const credPath = path.join(cwd, 'credentials.json');
  const exists = fs.existsSync(credPath);
  const easRelevant = easLink.kind === 'linked';

  if (!exists) {
    return {
      result: {
        name: 'credentials.json (EAS)',
        ok: true,
        warn: easRelevant,
        detail: easRelevant
          ? 'not present — needed if EAS submit/cloud should use the local JKS'
          : 'not present (skipped; project not linked to EAS)',
      },
      exists,
      valid: false,
    };
  }

  let cred: any;
  try {
    cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch (err: any) {
    return {
      result: {
        name: 'credentials.json (EAS)',
        ok: false,
        detail: `invalid JSON: ${err?.message || err}`,
      },
      exists,
      valid: false,
    };
  }

  const ksPath: string | undefined = cred?.android?.keystore?.keystorePath;
  if (!ksPath) {
    return {
      result: {
        name: 'credentials.json (EAS)',
        ok: true,
        warn: true,
        detail: 'missing android.keystore.keystorePath',
      },
      exists,
      valid: false,
    };
  }
  const absKs = path.resolve(cwd, ksPath);
  if (!fs.existsSync(absKs)) {
    return {
      result: {
        name: 'credentials.json (EAS)',
        ok: true,
        warn: true,
        detail: `keystorePath "${ksPath}" not found on disk`,
      },
      exists,
      valid: false,
    };
  }
  if (props) {
    const propsAbs = path.resolve(cwd, 'android', 'app', props.storeFile);
    if (path.resolve(absKs) !== propsAbs) {
      return {
        result: {
          name: 'credentials.json (EAS)',
          ok: true,
          warn: true,
          detail: `points to ${ksPath} but keystore.properties uses ${props.storeFile}`,
        },
        exists,
        valid: false,
      };
    }
  }
  return {
    result: { name: 'credentials.json (EAS)', ok: true, detail: ksPath },
    exists,
    valid: true,
  };
}

interface SuggestionCtx {
  androidPkg: AndroidPackageCheck;
  easLink: EasLinkResult;
  ks: KeystorePropsCheck;
  jks: CheckResult;
  cred: CredentialsJsonCheck;
}

function suggestPackageName(appJson: any): string {
  const ios = appJson?.expo?.ios?.bundleIdentifier;
  if (typeof ios === 'string' && ANDROID_PKG_RE.test(ios)) return ios;
  const seed: unknown = appJson?.expo?.slug || appJson?.expo?.name || 'myapp';
  const cleaned = String(seed).toLowerCase().replace(/[^a-z0-9]/g, '');
  const safe = cleaned && /^[a-z]/.test(cleaned) ? cleaned : `app${cleaned || 'name'}`;
  return `com.example.${safe}`;
}

async function offerAndroidPackageFix(
  cwd: string,
  androidPkg: AndroidPackageCheck,
  results: CheckResult[],
  dryRun: boolean
): Promise<boolean> {
  // Only offer when we can safely write app.json and the field is genuinely missing.
  // Skip malformed values (don't overwrite intentional input) and dynamic configs.
  if (!process.stdin.isTTY || dryRun) return false;
  if (androidPkg.source !== 'app.json') return false;
  if (androidPkg.pkg !== null) return false;

  const appJsonPath = path.join(cwd, 'app.json');
  let appJson: any;
  try {
    appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  } catch {
    return false; // malformed JSON — caller already showed an error row
  }

  log.warn(
    'expo.android.package is missing in app.json. Gradle and EAS sync will both fail without it.'
  );
  const yes = await confirm({
    message: 'Add `expo.android.package` to app.json now?',
    default: true,
  });
  if (!yes) {
    log.dim('Skipped. Add expo.android.package to app.json manually before building.');
    return false;
  }

  const suggested = suggestPackageName(appJson);
  const pkg = (
    await input({
      message: 'Android applicationId (e.g. com.yourcompany.yourapp):',
      default: suggested,
      validate: (v) =>
        ANDROID_PKG_RE.test(v.trim()) ||
        'Need at least two dot-separated segments, each starting with a letter (e.g. com.yourcompany.yourapp)',
    })
  ).trim();

  appJson.expo = appJson.expo || {};
  appJson.expo.android = appJson.expo.android || {};
  appJson.expo.android.package = pkg;
  fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n', 'utf8');
  invalidateExpoConfigCache(cwd);
  log.ok(`Wrote expo.android.package = "${pkg}" to app.json`);

  const idx = results.indexOf(androidPkg.result);
  if (idx !== -1) {
    results[idx] = { name: 'Android package (app.json)', ok: true, detail: pkg };
  }
  return true;
}

function buildSuggestions({ androidPkg, easLink, ks, jks, cred }: SuggestionCtx): string[] {
  const out: string[] = [];

  if (!androidPkg.result.ok && androidPkg.source === 'app.json') {
    out.push(
      'Set the Android applicationId in app.json:\n' +
        '     { "expo": { "android": { "package": "com.yourcompany.yourapp" } } }'
    );
  } else if (!androidPkg.result.ok && androidPkg.source === 'none') {
    out.push('Run inside an Expo project root (no app.json or app.config.* detected).');
  }

  if (easLink.kind === 'not-linked') {
    out.push('Link this project to EAS:                eas init');
  }
  if (easLink.kind === 'linked' && !easLink.hasEasJson) {
    out.push('Create eas.json:                         eas build:configure --platform android');
  }
  if (!ks.fileExists) {
    // Prefer rehydrate when credentials.json + .jks are already on disk —
    // it's one prompt and no password re-entry.
    if (jks.warn && /keystore rehydrate/.test(jks.detail || '')) {
      out.push('Rehydrate from credentials.json:         npx local-expo-build keystore rehydrate');
    } else {
      out.push('Set up the signing keystore:             npx local-expo-build keystore setup');
    }
  } else if (!ks.props) {
    out.push('Finish keystore.properties:              fill in storePassword / keyPassword (no FILL_IN)');
  } else if (jks.warn) {
    out.push(
      'Add the .jks file:                       npx local-expo-build keystore create | import | fetch | rehydrate'
    );
  }
  if (cred.result.warn && !cred.exists) {
    out.push(
      '(Optional) Create credentials.json so EAS submit/cloud reuses your local JKS — see\n' +
        '     https://docs.expo.dev/app-signing/local-credentials/'
    );
  } else if (cred.result.warn && cred.exists) {
    out.push('Fix credentials.json:                    align keystorePath with keystore.properties');
  }

  return out;
}

export interface RunDoctorOpts {
  cwd: string;
  dryRun: boolean;
  /** When true, prefix the section header (default 'local-expo-build doctor'). */
  title?: string;
  skipUpdateCheck?: boolean;
}

export interface RunDoctorResult {
  results: CheckResult[];
  failedCount: number;
}

/**
 * Runs the full doctor flow: checks the environment, prints results, offers
 * interactive auto-fixes, and returns a summary. Callers (e.g. `init`) decide
 * whether to exit on failure — this function never calls process.exit.
 */
export async function runDoctor({
  cwd,
  dryRun,
  title,
  skipUpdateCheck,
}: RunDoctorOpts): Promise<RunDoctorResult> {
  log.step(title || 'local-expo-build doctor');

  const results: CheckResult[] = [];

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  results.push({
    name: 'Node >= 20',
    ok: nodeMajor >= 20,
    detail: `v${process.versions.node}`,
  });

  const java = await which('java', ['-version']);
  results.push({ name: 'JDK (java)', ok: !!java, detail: java || 'not found' });

  const keytool = await which('keytool', ['-help']);
  results.push({ name: 'keytool', ok: !!keytool, detail: keytool ? 'present' : 'not found' });

  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  results.push({
    name: 'ANDROID_HOME / ANDROID_SDK_ROOT',
    ok: !!androidHome,
    detail: androidHome || 'not set',
  });

  if (androidHome) {
    const sdkmanager = path.join(
      androidHome,
      'cmdline-tools',
      'latest',
      'bin',
      process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'
    );
    results.push({
      name: 'sdkmanager',
      ok: fs.existsSync(sdkmanager),
      detail: sdkmanager,
      warn: !fs.existsSync(sdkmanager),
    });
  }

  const eas = await which('eas', ['--version']);
  results.push({
    name: 'eas-cli',
    ok: !!eas,
    detail: eas || 'not found (optional; needed for EAS sync)',
    warn: !eas,
  });

  // iOS prerequisites — only meaningful on macOS. On other platforms we
  // show a single dim "skipped (not macOS)" row instead of failing.
  if (process.platform === 'darwin') {
    const xcb = await which('xcodebuild', ['-version']);
    results.push({
      name: 'xcodebuild (iOS, optional)',
      ok: !!xcb,
      detail: xcb || 'not found (install Xcode from the App Store)',
      warn: !xcb,
    });
    const xcrun = await which('xcrun', ['--version']);
    results.push({
      name: 'xcrun (iOS, optional)',
      ok: !!xcrun,
      detail: xcrun || 'not found (ships with Xcode Command Line Tools)',
      warn: !xcrun,
    });
  } else {
    results.push({
      name: 'iOS build prerequisites',
      ok: true,
      warn: true,
      detail: `skipped — iOS builds require macOS (you're on ${process.platform})`,
    });
  }

  const expoBin = await projectBinVersion('expo', cwd);
  results.push({
    name: 'expo CLI (in project)',
    ok: !!expoBin,
    detail: expoBin || 'not found — run `npm install` / `bun install` in your project',
  });

  try {
    const sdk = detectExpoSdk(cwd);
    const supported = sdk.major in GRADLE_PIN;
    results.push({
      name: `Expo SDK detected`,
      ok: true,
      detail: `${sdk.major} (${sdk.raw})${supported ? '' : ' — not in GRADLE_PIN table'}`,
      warn: !supported,
    });
  } catch (err: any) {
    results.push({ name: 'Expo SDK detected', ok: false, detail: err?.message || String(err) });
  }

  const androidPkg = androidPackageCheck(cwd);
  results.push(androidPkg.result);

  const easLink = detectEasLink(cwd);
  results.push(easLinkCheck(easLink));

  const ksProps = keystorePropsCheck(cwd);
  results.push(ksProps.result);
  const jksResult = jksCheck(cwd, ksProps.props);
  results.push(jksResult);
  const credResult = credentialsJsonCheck(cwd, ksProps.props, easLink);
  results.push(credResult.result);

  const scriptStatuses = compareScripts(cwd);
  const scaffolded = scriptStatuses.filter((s) => s.exists);
  const outdatedScripts = scaffolded.filter((s) => s.contentDiffers);
  if (scaffolded.length) {
    const latest = scriptStatuses[0]?.templateVersion || '?';
    results.push({
      name: 'Scaffolded scripts',
      ok: outdatedScripts.length === 0,
      warn: outdatedScripts.length > 0,
      detail:
        outdatedScripts.length === 0
          ? `up to date (v${scaffolded[0]?.userVersion || latest})`
          : `${outdatedScripts.length} outdated — bundled v${latest}`,
    });
  }

  console.log('');
  for (const r of results) {
    const icon = r.ok ? (r.warn ? kleur.yellow('!') : kleur.green('✓')) : kleur.red('✗');
    console.log(`  ${icon} ${r.name.padEnd(35)} ${kleur.gray(r.detail || '')}`);
  }
  console.log('');

  const suggestions = buildSuggestions({
    androidPkg,
    easLink,
    ks: ksProps,
    jks: jksResult,
    cred: credResult,
  });
  if (suggestions.length) {
    console.log(kleur.bold('Suggested next steps to complete setup:'));
    suggestions.forEach((s, i) => console.log(`  ${kleur.cyan(`${i + 1}.`)} ${s}`));
    console.log('');
  }

  if (outdatedScripts.length) {
    console.log(kleur.bold('Scaffolded script updates:'));
    console.log(
      `  ${kleur.cyan('1.')} Refresh scripts: npx local-expo-build update-scripts`
    );
    console.log('');
  }

  await offerAndroidPackageFix(cwd, androidPkg, results, dryRun);

  const interactive = process.stdin.isTTY && !dryRun;
  let currentEasLink = easLink;

  // Step 1 — Link EAS project (`eas init`)
  if (
    interactive &&
    !!eas &&
    currentEasLink.kind !== 'linked' &&
    currentEasLink.kind !== 'no-expo-config'
  ) {
    log.warn(
      'This project is not linked to EAS. Linking enables managed keystore storage, ' +
        'remote credentials, and `local-expo-build keystore fetch`.'
    );
    const yes = await confirm({
      message: 'Run `eas init` now to link this project?',
      default: true,
    });
    if (yes) {
      try {
        await execa('eas', ['init'], { cwd, stdio: 'inherit' });
        log.ok('EAS link complete.');
        currentEasLink = detectEasLink(cwd);
        replaceResultByName(results, 'EAS project linked', easLinkCheck(currentEasLink));
      } catch (err: any) {
        log.error(`eas init failed: ${err?.shortMessage || err?.message || err}`);
      }
    } else {
      log.dim('Skipped. You can link later with `eas init`.');
    }
    console.log('');
  } else if (!eas && currentEasLink.kind !== 'linked' && currentEasLink.kind !== 'no-expo-config') {
    log.dim('Install eas-cli (npm i -g eas-cli) to link this project for managed keystores.');
    console.log('');
  }

  // Step 2 — Create eas.json (`eas build:configure`)
  if (
    interactive &&
    !!eas &&
    currentEasLink.kind === 'linked' &&
    !currentEasLink.hasEasJson
  ) {
    log.warn('eas.json is missing — required by `eas credentials` and EAS submit/cloud builds.');
    const yes = await confirm({
      message: 'Run `eas build:configure --platform android` now to create eas.json?',
      default: true,
    });
    if (yes) {
      try {
        await execa('eas', ['build:configure', '--platform', 'android'], { cwd, stdio: 'inherit' });
        log.ok('eas.json created.');
        currentEasLink = detectEasLink(cwd);
        replaceResultByName(results, 'EAS project linked', easLinkCheck(currentEasLink));
      } catch (err: any) {
        log.error(`eas build:configure failed: ${err?.shortMessage || err?.message || err}`);
      }
    } else {
      log.dim('Skipped. Run later: eas build:configure --platform android');
    }
    console.log('');
  }

  // Step 3a — Rehydrate from credentials.json if possible (skips picker + password re-entry)
  if (interactive && !readKeystoreProps(cwd) && findRehydrateCandidate(cwd)) {
    log.warn('Found credentials.json + .jks but no keystore.properties.');
    log.dim('We can bind them by copying the .jks into android/app/ and writing keystore.properties.');
    const yes = await confirm({
      message: 'Rehydrate keystore.properties from credentials.json now? (no password re-entry)',
      default: true,
    });
    if (yes) {
      try {
        await ensureKeystore(cwd, 'rehydrate');
        const after = keystorePropsCheck(cwd);
        replaceResultByName(results, 'keystore.properties', after.result);
        replaceResultByName(results, 'Signing keystore (.jks)', jksCheck(cwd, after.props));
        replaceResultByName(
          results,
          'credentials.json (EAS)',
          credentialsJsonCheck(cwd, after.props, currentEasLink).result
        );
      } catch (err: any) {
        log.error(`Rehydrate failed: ${err?.message || err}`);
      }
    } else {
      log.dim('Skipped. Run later: npx local-expo-build keystore rehydrate');
    }
    console.log('');
  }

  // Step 3b — Generic keystore setup (only if 3a didn't already establish keystore.properties)
  const ksFresh = keystorePropsCheck(cwd);
  if (interactive && !ksFresh.fileExists) {
    log.warn('No keystore.properties yet — release builds need a signing keystore.');
    const yes = await confirm({
      message: 'Set up the Android signing keystore now?',
      default: true,
    });
    if (yes) {
      try {
        await ensureKeystore(cwd);
        const after = keystorePropsCheck(cwd);
        replaceResultByName(results, 'keystore.properties', after.result);
        replaceResultByName(results, 'Signing keystore (.jks)', jksCheck(cwd, after.props));
        replaceResultByName(
          results,
          'credentials.json (EAS)',
          credentialsJsonCheck(cwd, after.props, currentEasLink).result
        );
      } catch (err: any) {
        log.error(`Keystore setup failed: ${err?.message || err}`);
      }
    } else {
      log.dim('Skipped. Run later: npx local-expo-build keystore setup');
    }
    console.log('');
  }

  await maybePromptScriptUpdate({
    cwd,
    dryRun,
    skip: skipUpdateCheck,
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    log.error(`${failed.length} check(s) failed.`);
  } else {
    log.ok('Environment looks good.');
  }
  return { results, failedCount: failed.length };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check your local environment for Expo Android builds')
    .action(async (_opts, cmd) => {
      const { cwd, dryRun, skipUpdateCheck } = getCtx(cmd);
      const { failedCount } = await runDoctor({ cwd, dryRun, skipUpdateCheck });
      if (failedCount > 0) process.exit(1);
    });
}

import fs from 'fs';
import os from 'os';
import path from 'path';
import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import kleur from 'kleur';
import semver from 'semver';
import {
  detectPackageManager,
  formatCliInvoke,
  getRunnerInvocation,
  PackageManager,
} from './resolveProjectBin';

const PKG_NAME = 'local-expo-build';
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

export interface CliUpdateInfo {
  current: string;
  latest: string;
}

function cacheFilePath(): string {
  return path.join(os.homedir(), '.cache', PKG_NAME, 'registry-version.json');
}

function readCache(): UpdateCache | null {
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as UpdateCache;
    if (typeof parsed.checkedAt === 'number' && typeof parsed.latest === 'string') {
      return parsed;
    }
  } catch {
    // no cache yet
  }
  return null;
}

function writeCache(latest: string): void {
  const file = cacheFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ checkedAt: Date.now(), latest } satisfies UpdateCache),
    'utf8'
  );
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

/** Returns registry latest when it is newer than `current`. */
export function isCliUpdateAvailable(current: string, latest: string): boolean {
  const cur = semver.valid(current);
  const lat = semver.valid(latest);
  if (!cur || !lat) return false;
  return semver.gt(lat, cur);
}

export function formatCliUpdateMessage(
  info: CliUpdateInfo,
  pm: PackageManager = 'npm',
  subcommand = ''
): string {
  const cmd = formatCliInvoke(pm, subcommand);
  return (
    kleur.yellow(`! Update available: ${PKG_NAME} ${info.current} → ${info.latest}`) +
    '\n' +
    kleur.dim(`  Run: ${cmd}`)
  );
}

/** Args to forward when re-running via bunx/npx (drops the package name if present). */
export function forwardCliArgv(argv: string[] = process.argv): string[] {
  const rest = argv.slice(2);
  if (rest[0] === PKG_NAME) return rest.slice(1);
  return rest;
}

/**
 * Resolve the latest published version, using a 24h local cache to avoid
 * hitting the npm registry on every CLI invocation.
 */
export async function resolveLatestPublishedVersion(): Promise<string | null> {
  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.latest;
  }

  const latest = await fetchLatestVersion();
  if (latest) writeCache(latest);
  else if (cached) return cached.latest;
  return null;
}

export async function getCliUpdateInfo(currentVersion: string): Promise<CliUpdateInfo | null> {
  const latest = await resolveLatestPublishedVersion();
  if (!latest || !isCliUpdateAvailable(currentVersion, latest)) return null;
  return { current: currentVersion, latest };
}

export interface MaybePromptCliUpdateOpts {
  currentVersion: string;
  cwd?: string;
  /** Subcommand being run, echoed in the upgrade hint (e.g. `init`). */
  subcommand?: string;
  skip?: boolean;
  dryRun?: boolean;
  /** Re-run with @latest without prompting (pairs with non-TTY). */
  yesUpdate?: boolean;
}

async function reexecWithLatest(pm: PackageManager, forwardedArgv: string[]): Promise<never> {
  const { command, args } = getRunnerInvocation(pm);
  const result = await execa(command, [...args, ...forwardedArgv], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  process.exit(result.exitCode ?? 0);
}

/**
 * When a newer npm release exists, warn the user and (in an interactive TTY)
 * ask whether to re-run the same command with @latest.
 */
export async function maybePromptCliUpdate(opts: MaybePromptCliUpdateOpts): Promise<void> {
  if (opts.skip || process.env.LOCAL_EXPO_BUILD_SKIP_UPDATE_CHECK === '1') return;

  const info = await getCliUpdateInfo(opts.currentVersion);
  if (!info) return;

  const pm = detectPackageManager(opts.cwd || process.cwd());
  const forwardedArgv = forwardCliArgv().filter((arg) => arg !== '--yes-update');

  if (opts.dryRun) {
    console.warn(formatCliUpdateMessage(info, pm, opts.subcommand));
    console.warn('');
    return;
  }

  if (opts.yesUpdate) {
    await reexecWithLatest(pm, forwardedArgv);
  }

  if (!process.stdin.isTTY) {
    console.warn(formatCliUpdateMessage(info, pm, opts.subcommand));
    console.warn('');
    return;
  }

  console.warn(kleur.yellow(`! Update available: ${PKG_NAME} ${info.current} → ${info.latest}`));
  const shouldUpdate = await confirm({
    message: `Update to v${info.latest} and re-run?`,
    default: true,
  });

  if (shouldUpdate) {
    await reexecWithLatest(pm, forwardedArgv);
  }

  console.warn(kleur.dim(`Continuing with v${info.current}.`));
  console.warn('');
}

/** @deprecated Use maybePromptCliUpdate */
export const maybeNotifyCliUpdate = maybePromptCliUpdate;

/** @internal — tests only */
export const _testing = {
  readCache,
  writeCache,
  CACHE_TTL_MS,
  cacheFilePath,
};

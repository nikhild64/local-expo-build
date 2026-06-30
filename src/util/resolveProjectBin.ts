import fs from 'fs';
import path from 'path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface ProjectBinInvocation {
  /** Executable passed to execa/spawn as the command. */
  command: string;
  /** Arguments before the CLI subcommand (e.g. path to cli.js when command is node). */
  prefixArgs: string[];
  /** Extra execa options (e.g. shell: true for .cmd on Windows). */
  execa?: { shell?: boolean };
}

/**
 * Resolves a package CLI from the project's node_modules without npx/bunx.
 * Works with npm, pnpm, yarn, and Bun install layouts.
 */
export function resolveProjectBin(name: string, cwd: string): ProjectBinInvocation | null {
  const isWin = process.platform === 'win32';

  const moduleCandidates = [`${name}/bin/cli`, `@${name}/cli/build/bin/cli`];

  for (const subpath of moduleCandidates) {
    try {
      const entry = require.resolve(subpath, { paths: [cwd] });
      return { command: process.execPath, prefixArgs: [entry] };
    } catch {
      // try next candidate
    }
  }

  const shim = path.join(cwd, 'node_modules', '.bin', isWin ? `${name}.cmd` : name);
  if (fs.existsSync(shim)) {
    return isWin
      ? { command: shim, prefixArgs: [], execa: { shell: true } }
      : { command: shim, prefixArgs: [] };
  }

  return null;
}

/** Flatten invocation + user args for execa/spawn. */
export function projectBinExecArgs(
  invocation: ProjectBinInvocation,
  args: string[]
): { command: string; args: string[]; execa?: { shell?: boolean } } {
  return {
    command: invocation.command,
    args: [...invocation.prefixArgs, ...args],
    execa: invocation.execa,
  };
}

/** Best-effort package manager detection for user-facing hints. */
export function detectPackageManager(cwd: string): PackageManager {
  const pkgPath = path.join(cwd, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const pm = pkg.packageManager?.split('@')[0];
    if (pm === 'bun' || pm === 'pnpm' || pm === 'yarn' || pm === 'npm') return pm;
  } catch {
    // ignore malformed package.json
  }

  if (fs.existsSync(path.join(cwd, 'bun.lock')) || fs.existsSync(path.join(cwd, 'bun.lockb'))) {
    return 'bun';
  }
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** Format a package.json script invocation for the detected package manager. */
export function formatRunScript(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    case 'pnpm':
      return `pnpm run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

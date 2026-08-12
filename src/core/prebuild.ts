import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execa } from 'execa';
import { log } from '../util/log';
import { nodeOptionsWithRam, parseRamMb } from '../util/ram';
import { projectBinExecArgs, resolveProjectBin } from '../util/resolveProjectBin';

export interface PrebuildOpts {
  cwd: string;
  clean?: boolean;
  maxRam?: string;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * The `expo prebuild` CLI args. `--non-interactive` was removed from expo CLI
 * (SDK 54+ warns "use $CI=1 instead"), so non-interactivity is handled by
 * {@link prebuildEnv} setting CI=1 — supported on old and new SDKs alike.
 */
export function prebuildArgs(clean: boolean): string[] {
  return ['prebuild', '--platform', 'android', ...(clean ? ['--clean'] : [])];
}

/** Environment for the spawned expo CLI — CI=1 is the supported non-interactive switch. */
export function prebuildEnv(): Record<string, string | undefined> {
  return { ...process.env, CI: '1' };
}

export async function prebuild({ cwd, clean = false, maxRam, onLine, signal }: PrebuildOpts): Promise<void> {
  const isWin = process.platform === 'win32';
  if (isWin) {
    const androidDir = path.join(cwd, 'android');
    const wrapper = path.join(androidDir, 'gradlew.bat');
    if (fs.existsSync(wrapper)) {
      try {
        log.dim('Stopping Gradle daemon to release file locks before prebuild...');
        await execa(wrapper, ['--stop'], { cwd: androidDir, stdio: 'ignore' });
      } catch (e) {
        // ignore
      }
    }
  }

  const args = prebuildArgs(clean);
  log.info(`expo ${args.join(' ')}`);
  const bin = resolveProjectBin('expo', cwd);
  if (!bin) {
    throw new Error(
      'expo CLI not found — install dependencies in your project (`npm install`, `bun install`, etc.)'
    );
  }
  const { command, args: execArgs, execa: execaOpts } = projectBinExecArgs(bin, args);
  const ramMb = parseRamMb(maxRam);
  const env = prebuildEnv();
  if (ramMb) {
    // Append to any pre-existing NODE_OPTIONS instead of clobbering it (D6).
    env.NODE_OPTIONS = nodeOptionsWithRam(ramMb, env.NODE_OPTIONS);
  }
  log.debug(`resolved expo bin: ${command} ${execArgs.join(' ')}`);
  if (ramMb) log.debug(`prebuild NODE_OPTIONS: ${env.NODE_OPTIONS}`);

  if (onLine) {
    const proc = execa(command, execArgs, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'], cancelSignal: signal, ...execaOpts });
    let rl: readline.Interface | undefined;
    let rlErr: readline.Interface | undefined;
    if (proc.stdout) {
      rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (l) => {
        process.stdout.write(l + '\n');
        onLine(l);
      });
    }
    if (proc.stderr) {
      rlErr = readline.createInterface({ input: proc.stderr });
      rlErr.on('line', (l) => {
        process.stderr.write(l + '\n');
        onLine(l);
      });
    }
    try {
      await proc;
    } finally {
      rl?.close();
      rlErr?.close();
    }
  } else {
    await execa(command, execArgs, { cwd, env, stdio: 'inherit', cancelSignal: signal, ...execaOpts });
  }
}

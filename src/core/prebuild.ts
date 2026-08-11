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

  const args = ['prebuild', '--platform', 'android', '--non-interactive'];
  if (clean) args.push('--clean');
  log.info(`expo ${args.join(' ')}`);
  const bin = resolveProjectBin('expo', cwd);
  if (!bin) {
    throw new Error(
      'expo CLI not found — install dependencies in your project (`npm install`, `bun install`, etc.)'
    );
  }
  const { command, args: execArgs, execa: execaOpts } = projectBinExecArgs(bin, args);
  const ramMb = parseRamMb(maxRam);
  const env: Record<string, string | undefined> = { ...process.env };
  if (ramMb) {
    // Append to any pre-existing NODE_OPTIONS instead of clobbering it (D6).
    env.NODE_OPTIONS = nodeOptionsWithRam(ramMb, env.NODE_OPTIONS);
  }

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

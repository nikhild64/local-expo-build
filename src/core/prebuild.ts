import readline from 'readline';
import { execa } from 'execa';
import { log } from '../util/log';
import { projectBinExecArgs, resolveProjectBin } from '../util/resolveProjectBin';

export interface PrebuildOpts {
  cwd: string;
  clean?: boolean;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export async function prebuild({ cwd, clean = false, onLine, signal }: PrebuildOpts): Promise<void> {
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
  if (onLine) {
    const proc = execa(command, execArgs, { cwd, stdio: ['inherit', 'pipe', 'pipe'], signal, ...execaOpts });
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
    await execa(command, execArgs, { cwd, stdio: 'inherit', ...execaOpts });
  }
}

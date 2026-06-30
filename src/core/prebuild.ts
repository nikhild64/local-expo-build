import { execa } from 'execa';
import { log } from '../util/log';
import { projectBinExecArgs, resolveProjectBin } from '../util/resolveProjectBin';

export interface PrebuildOpts {
  cwd: string;
  clean?: boolean;
}

export async function prebuild({ cwd, clean = false }: PrebuildOpts): Promise<void> {
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
  await execa(command, execArgs, { cwd, stdio: 'inherit', ...execaOpts });
}

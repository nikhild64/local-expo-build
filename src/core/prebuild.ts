import { execa } from 'execa';
import { log } from '../util/log';

export interface PrebuildOpts {
  cwd: string;
  clean?: boolean;
}

export async function prebuild({ cwd, clean = false }: PrebuildOpts): Promise<void> {
  const args = ['prebuild', '--platform', 'android', '--non-interactive'];
  if (clean) args.push('--clean');
  log.info(`expo ${args.join(' ')}`);
  await execa('npx', ['--no-install', 'expo', ...args], {
    cwd,
    stdio: 'inherit',
  });
}

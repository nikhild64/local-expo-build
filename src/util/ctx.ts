import path from 'path';
import { Command } from 'commander';

export interface GlobalCtx {
  cwd: string;
  verbose: boolean;
  dryRun: boolean;
}

export function getCtx(cmd: Command): GlobalCtx {
  const opts = cmd.optsWithGlobals();
  const cwd = path.resolve(opts.cwd || process.cwd());
  return {
    cwd,
    verbose: Boolean(opts.verbose),
    dryRun: Boolean(opts.dryRun),
  };
}

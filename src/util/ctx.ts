import path from 'path';
import { Command } from 'commander';
import { setVerbose } from './log';

export interface GlobalCtx {
  cwd: string;
  verbose: boolean;
  dryRun: boolean;
  skipUpdateCheck: boolean;
}

export function getCtx(cmd: Command): GlobalCtx {
  const opts = cmd.optsWithGlobals();
  const verbose = Boolean(opts.verbose);
  // Every command flows through getCtx, so this is the single place that
  // turns the global `--verbose` flag into real debug logging.
  setVerbose(verbose);
  const cwd = path.resolve(opts.cwd || process.cwd());
  return {
    cwd,
    verbose,
    dryRun: Boolean(opts.dryRun),
    skipUpdateCheck: Boolean(opts.updateCheck === false),
  };
}

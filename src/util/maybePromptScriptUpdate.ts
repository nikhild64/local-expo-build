import path from 'path';
import { confirm } from '@inquirer/prompts';
import {
  applyScriptUpdates,
  getOutdatedScripts,
  hasScaffoldedScripts,
} from '../core/scaffoldScripts';
import { log } from './log';

export interface MaybePromptScriptUpdateOpts {
  cwd: string;
  dryRun: boolean;
  /** Set when `--no-update-check` is passed. */
  skip?: boolean;
}

/**
 * When the project uses scaffold mode and scripts/*.js lag behind the installed
 * CLI, warn the user and (in an interactive TTY) offer to refresh them.
 */
export async function maybePromptScriptUpdate(opts: MaybePromptScriptUpdateOpts): Promise<void> {
  if (opts.skip || !hasScaffoldedScripts(opts.cwd)) return;

  const outdated = getOutdatedScripts(opts.cwd);
  if (!outdated.length) return;

  const templateVersion = outdated[0].templateVersion || '?';
  log.warn(
    `${outdated.length} scaffolded script(s) are outdated (bundled v${templateVersion}).`
  );

  if (opts.dryRun) {
    log.dim('Run: npx local-expo-build update-scripts');
    return;
  }

  if (!process.stdin.isTTY) {
    log.dim('Run: npx local-expo-build update-scripts --yes');
    return;
  }

  const shouldUpdate = await confirm({
    message: `Update ${outdated.length} script(s) now?`,
    default: true,
  });
  if (!shouldUpdate) {
    log.dim('Skipped. Run later: npx local-expo-build update-scripts');
    return;
  }

  applyScriptUpdates(outdated);
  for (const s of outdated) {
    log.ok(
      `Updated ${path.relative(opts.cwd, s.userPath).replace(/\\/g, '/')} → v${s.templateVersion || '?'}`
    );
  }
  log.ok(`${outdated.length} script(s) refreshed.`);
  console.log('');
}

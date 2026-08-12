import kleur from 'kleur';

let verboseEnabled = false;

/** Turns verbose/debug logging on or off (wired from the global `--verbose` flag). */
export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export const log = {
  info: (msg: string) => console.log(kleur.cyan('› ') + msg),
  step: (msg: string) => console.log('\n' + kleur.bold().cyan('▸ ') + kleur.bold(msg)),
  ok: (msg: string) => console.log(kleur.green('✓ ') + msg),
  warn: (msg: string) => console.warn(kleur.yellow('! ') + msg),
  error: (msg: string) => console.error(kleur.red('✗ ') + msg),
  dim: (msg: string) => console.log(kleur.gray(msg)),
  /** Only printed when verbose logging is enabled (global `--verbose` flag). */
  debug: (msg: string) => {
    if (verboseEnabled) console.log(kleur.gray(`[debug] ${msg}`));
  },
};

import kleur from 'kleur';

export const log = {
  info: (msg: string) => console.log(kleur.cyan('› ') + msg),
  step: (msg: string) => console.log('\n' + kleur.bold().cyan('▸ ') + kleur.bold(msg)),
  ok: (msg: string) => console.log(kleur.green('✓ ') + msg),
  warn: (msg: string) => console.warn(kleur.yellow('! ') + msg),
  error: (msg: string) => console.error(kleur.red('✗ ') + msg),
  dim: (msg: string) => console.log(kleur.gray(msg)),
};

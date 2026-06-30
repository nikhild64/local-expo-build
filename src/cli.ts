import { Command } from 'commander';
import kleur from 'kleur';
import { registerBuildCommand } from './commands/build';
import { registerInitCommand } from './commands/init';
import { registerKeystoreCommand } from './commands/keystore';
import { registerDoctorCommand } from './commands/doctor';
import { registerUpdateCommand } from './commands/update';
import { maybePromptCliUpdate } from './util/checkCliUpdate';

const pkg = require('../package.json');

function runningSubcommand(actionCommand?: Command): string | undefined {
  if (!actionCommand) return undefined;
  const parts: string[] = [];
  let cmd: Command | undefined = actionCommand;
  while (cmd) {
    const name = cmd.name();
    if (!name || name === 'local-expo-build') break;
    parts.unshift(name);
    cmd = cmd.parent ?? undefined;
  }
  return parts.length ? parts.join(' ') : undefined;
}

const program = new Command();

program
  .name('local-expo-build')
  .description(
    'Local Expo Android build CLI — bypasses EAS cloud builds. ' +
      'Prebuild, pin Gradle, bump version, sign with your JKS, run gradlew, sync EAS.'
  )
  .version(pkg.version)
  .option('--cwd <path>', 'project directory (default: process.cwd())')
  .option('--verbose', 'verbose logging')
  .option('--dry-run', 'print actions without executing destructive steps')
  .option('--no-update-check', 'skip npm version + scaffolded script update checks')
  .option('--yes-update', 'if a newer npm release exists, re-run with @latest without prompting');

registerBuildCommand(program);
registerInitCommand(program);
registerKeystoreCommand(program);
registerDoctorCommand(program);
registerUpdateCommand(program);

program.hook('preAction', async (thisCommand, actionCommand) => {
  const argv = process.argv;
  if (argv.includes('--version') || argv.includes('-V') || argv.includes('--help') || argv.includes('-h')) {
    return;
  }

  const opts = thisCommand.optsWithGlobals();
  await maybePromptCliUpdate({
    currentVersion: pkg.version,
    cwd: opts.cwd || process.cwd(),
    subcommand: runningSubcommand(actionCommand),
    skip: opts.updateCheck === false,
    dryRun: Boolean(opts.dryRun),
    yesUpdate: Boolean(opts.yesUpdate),
  });
});

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(kleur.red('\nlocal-expo-build failed:'));
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  });

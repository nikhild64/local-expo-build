import { Command } from 'commander';
import kleur from 'kleur';
import { registerBuildCommand } from './commands/build';
import { registerInitCommand } from './commands/init';
import { registerKeystoreCommand } from './commands/keystore';
import { registerDoctorCommand } from './commands/doctor';

const pkg = require('../package.json');

const program = new Command();

program
  .name('expo-local-build')
  .description(
    'Local Expo Android build CLI — bypasses EAS cloud builds. ' +
      'Prebuild, pin Gradle, bump version, sign with your JKS, run gradlew, sync EAS.'
  )
  .version(pkg.version)
  .option('--cwd <path>', 'project directory (default: process.cwd())')
  .option('--verbose', 'verbose logging')
  .option('--dry-run', 'print actions without executing destructive steps');

registerBuildCommand(program);
registerInitCommand(program);
registerKeystoreCommand(program);
registerDoctorCommand(program);

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(kleur.red('\nexpo-local-build failed:'));
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  });

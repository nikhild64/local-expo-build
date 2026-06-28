import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { input, password } from '@inquirer/prompts';
import { writeKeystoreProps } from '../setupSigning';
import { log } from '../../util/log';

export async function generateKeystore(cwd: string): Promise<void> {
  const filename = await input({ message: 'Keystore filename:', default: 'release.jks' });
  const keyAlias = await input({ message: 'Key alias:', default: 'release' });
  const storePassword = await password({
    message: 'Keystore password (min 6 chars):',
    mask: '*',
    validate: (v) => (v.length >= 6 ? true : 'At least 6 characters'),
  });
  const keyPassword = await password({
    message: 'Key password (leave same as keystore):',
    mask: '*',
    validate: (v) => (v.length >= 6 ? true : 'At least 6 characters'),
  });
  const cn = await input({ message: 'Your name (CN):', default: 'Release Signer' });
  const org = await input({ message: 'Organization (O):', default: 'Unknown' });
  const country = await input({ message: 'Country code (C, 2 letters):', default: 'US' });

  const dname = `CN=${cn}, O=${org}, C=${country}`;
  const destDir = path.join(cwd, 'android', 'app');
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, filename);

  if (fs.existsSync(destPath)) {
    throw new Error(`Keystore already exists at ${destPath}. Delete it or choose a new name.`);
  }

  log.info(`Running keytool to generate ${destPath}...`);
  await execa(
    'keytool',
    [
      '-genkeypair',
      '-v',
      '-keystore',
      destPath,
      '-alias',
      keyAlias,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-storepass',
      storePassword,
      '-keypass',
      keyPassword,
      '-dname',
      dname,
    ],
    { stdio: 'inherit' }
  );

  // Belt-and-suspenders: keep a copy at project root so the .jks survives
  // `expo prebuild --clean` wiping android/. setupSigning's recovery step
  // looks here as a fallback. Gitignored via the `*.jks` entry.
  const rootBackup = path.join(cwd, filename);
  fs.copyFileSync(destPath, rootBackup);
  log.dim(`Backup → ${filename} (project root, gitignored)`);

  writeKeystoreProps(cwd, {
    storeFile: filename,
    storePassword,
    keyAlias,
    keyPassword,
  });
  log.ok(`Keystore generated and keystore.properties written.`);
  log.warn(
    `BACK UP ${destPath} AND YOUR PASSWORDS off-machine. Losing them means you cannot ship updates to your app.`
  );
}

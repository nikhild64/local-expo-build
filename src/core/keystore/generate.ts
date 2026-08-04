import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { input, password } from '@inquirer/prompts';
import { writeKeystoreProps } from '../setupSigning';
import { writeCredentialsJson } from '../writeCredentialsJson';
import { log } from '../../util/log';

export interface GenerateKeystoreParams {
  filename?: string;
  keyAlias?: string;
  storePassword?: string;
  keyPassword?: string;
  cn?: string;
  org?: string;
  country?: string;
}

export async function generateKeystore(
  cwd: string,
  params?: GenerateKeystoreParams
): Promise<void> {
  let filename: string;
  let keyAlias: string;
  let storePassword: string;
  let keyPassword: string;
  let cn: string;
  let org: string;
  let country: string;

  if (params !== undefined) {
    if (!params.storePassword) {
      throw new Error('Keystore password is required (minimum 6 characters).');
    }
    filename = params.filename || 'release.p12';
    keyAlias = params.keyAlias || 'release';
    storePassword = params.storePassword;
    keyPassword = params.keyPassword || storePassword;
    cn = params.cn || 'Release Signer';
    org = params.org || 'Unknown';
    country = params.country || 'US';

    if (storePassword.length < 6) {
      throw new Error('Keystore password must be at least 6 characters.');
    }
    if (keyPassword.length < 6) {
      throw new Error('Key password must be at least 6 characters.');
    }
  } else {
    filename = await input({ message: 'Keystore filename:', default: 'release.p12' });
    keyAlias = await input({ message: 'Key alias:', default: 'release' });
    storePassword = await password({
      message: 'Keystore password (min 6 chars):',
      mask: '*',
      validate: (v) => (v.length >= 6 ? true : 'At least 6 characters'),
    });
    keyPassword = await password({
      message: 'Key password (leave same as keystore):',
      mask: '*',
      validate: (v) => (v.length >= 6 ? true : 'At least 6 characters'),
    });
    cn = await input({ message: 'Your name (CN):', default: 'Release Signer' });
    org = await input({ message: 'Organization (O):', default: 'Unknown' });
    country = await input({ message: 'Country code (C, 2 letters):', default: 'US' });
  }

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
      '-storetype',
      'PKCS12',
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
    { stdio: params ? 'pipe' : 'inherit' }
  );

  // Belt-and-suspenders: keep a copy at project root so the keystore survives
  // `expo prebuild --clean` wiping android/. setupSigning's recovery step
  // looks here as a fallback. Gitignored via `*.p12` / `*.jks` entries.
  const rootBackup = path.join(cwd, filename);
  fs.copyFileSync(destPath, rootBackup);
  log.dim(`Backup → ${filename} (project root, gitignored)`);

  writeKeystoreProps(cwd, {
    storeFile: filename,
    storePassword,
    keyAlias,
    keyPassword,
  });
  writeCredentialsJson(cwd, {
    storeFile: filename,
    storePassword,
    keyAlias,
    keyPassword,
  });
  log.ok(`Keystore generated, keystore.properties & credentials.json written.`);
  log.warn(
    `BACK UP ${destPath} AND YOUR PASSWORDS off-machine. Losing them means you cannot ship updates to your app.`
  );
}

import fs from 'fs';
import path from 'path';
import { EasAuth, easGraphql } from '../eas/api';
import { ensureGitignoreEntries } from '../../util/gitignore';
import { KeystoreProps, writeKeystoreProps } from '../setupSigning';
import { writeCredentialsJson } from '../writeCredentialsJson';

export interface EasKeystoreSummary {
  buildCredentialsId: string;
  name: string;
  isDefault: boolean;
  keyAlias: string;
  type: 'JKS' | 'PKCS12' | 'UNKNOWN';
  md5Fingerprint?: string;
  applicationIdentifier?: string;
}

interface RemoteKeystore extends EasKeystoreSummary {
  keystore?: string | null;
  keystorePassword?: string | null;
  keyPassword?: string | null;
}

const KEYSTORES_QUERY = `
  query AndroidKeystores($appId: String!) {
    app { byId(appId: $appId) {
      androidAppCredentials {
        applicationIdentifier
        androidAppBuildCredentialsList {
          id name isDefault
          androidKeystore {
            keystore keystorePassword keyAlias keyPassword type md5CertificateFingerprint
          }
        }
      }
    } }
  }`;

function flattenKeystores(data: any): RemoteKeystore[] {
  const credentials = data?.app?.byId?.androidAppCredentials;
  if (!Array.isArray(credentials)) return [];
  return credentials.flatMap((android: any) =>
    (android.androidAppBuildCredentialsList || []).filter((build: any) => build.androidKeystore).map((build: any) => ({
      buildCredentialsId: build.id,
      name: build.name || build.id,
      isDefault: !!build.isDefault,
      applicationIdentifier: android.applicationIdentifier,
      keyAlias: build.androidKeystore.keyAlias || '',
      type: build.androidKeystore.type || 'UNKNOWN',
      md5Fingerprint: build.androidKeystore.md5CertificateFingerprint || undefined,
      keystore: build.androidKeystore.keystore,
      keystorePassword: build.androidKeystore.keystorePassword,
      keyPassword: build.androidKeystore.keyPassword,
    }))
  );
}

export async function listEasKeystores(projectId: string, auth?: EasAuth | null): Promise<EasKeystoreSummary[]> {
  const data = await easGraphql<any>(KEYSTORES_QUERY, { appId: projectId }, auth);
  return flattenKeystores(data).map(({ keystore, keystorePassword, keyPassword, ...summary }) => summary);
}

export function isValidKeystoreBuffer(buffer: Buffer): boolean {
  return buffer.length >= 2 && (
    (buffer.length >= 4 && buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfe && buffer[3] === 0xed) ||
    (buffer[0] === 0x30 && buffer[1] === 0x82)
  );
}

export async function fetchEasKeystore(
  cwd: string,
  projectId: string,
  buildCredentialsId?: string,
  overwrite = false,
  auth?: EasAuth | null
): Promise<{ storeFile: string; keyAlias: string }> {
  if (!projectId) throw new Error('This project is not linked to EAS. Link an EAS project first.');
  const data = await easGraphql<any>(KEYSTORES_QUERY, { appId: projectId }, auth);
  const keystores = flattenKeystores(data);
  if (!keystores.length) throw new Error('EAS has no Android keystore for this project yet.');
  const remote = buildCredentialsId
    ? keystores.find((entry) => entry.buildCredentialsId === buildCredentialsId)
    : keystores.find((entry) => entry.isDefault) || keystores[0];
  if (!remote) throw new Error('The selected EAS build credentials were not found.');
  if (!remote.keystore) throw new Error('EAS returned this keystore without its secret. Your account may not have permission to read it.');
  if (!remote.keystorePassword || !remote.keyAlias) throw new Error('EAS returned incomplete Android keystore credentials.');

  const bytes = Buffer.from(remote.keystore, 'base64');
  if (!isValidKeystoreBuffer(bytes)) throw new Error('EAS returned an invalid or truncated keystore file.');
  const extension = remote.type === 'PKCS12' ? 'p12' : bytes[0] === 0x30 && bytes[1] === 0x82 ? 'p12' : 'jks';
  const storeFile = `release.${extension}`;
  const appDestination = path.join(cwd, 'android', 'app', storeFile);
  const rootBackup = path.join(cwd, storeFile);
  if (!overwrite && (fs.existsSync(appDestination) || fs.existsSync(rootBackup))) {
    const err: any = new Error(`A keystore already exists at android/app/${storeFile}. Confirm replacement before overwriting it.`);
    err.status = 409;
    throw err;
  }

  ensureGitignoreEntries(cwd, ['keystore.properties', '*.jks', 'credentials.json', ...(extension === 'p12' ? ['*.p12'] : [])]);
  fs.mkdirSync(path.dirname(appDestination), { recursive: true });
  fs.writeFileSync(appDestination, bytes);
  fs.writeFileSync(rootBackup, bytes);
  const props: KeystoreProps = {
    storeFile,
    storePassword: remote.keystorePassword,
    keyAlias: remote.keyAlias,
    keyPassword: remote.keyPassword || remote.keystorePassword,
  };
  writeKeystoreProps(cwd, props);
  writeCredentialsJson(cwd, props);
  return { storeFile, keyAlias: props.keyAlias };
}
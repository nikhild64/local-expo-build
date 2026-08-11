import fs from 'fs';
import path from 'path';
import { EasAuth, easGraphql } from '../eas/api';
import { ensureGitignoreEntries } from '../../util/gitignore';
import { KeystoreProps, readKeystoreProps, writeKeystoreProps } from '../setupSigning';
import { writeCredentialsJson } from '../writeCredentialsJson';
import { readExpoConfig } from '../expoConfig';

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

const GET_APP_INFO_QUERY = `
  query GetAppInfo($appId: String!) {
    app { byId(appId: $appId) {
      id
      ownerAccount {
        id
      }
      androidAppCredentials {
        id
        applicationIdentifier
      }
    } }
  }`;

const CREATE_APP_CREDENTIALS_MUTATION = `
  mutation CreateAndroidAppCredentials($appId: ID!, $applicationIdentifier: String!) {
    androidAppCredentials {
      createAndroidAppCredentials(
        appId: $appId,
        applicationIdentifier: $applicationIdentifier,
        androidAppCredentialsInput: {}
      ) {
        id
        applicationIdentifier
      }
    }
  }`;

const CREATE_KEYSTORE_OBJECT_MUTATION = `
  mutation CreateAndroidKeystore($accountId: ID!, $androidKeystoreInput: AndroidKeystoreInput!) {
    androidKeystore {
      createAndroidKeystore(
        accountId: $accountId,
        androidKeystoreInput: $androidKeystoreInput
      ) {
        id
      }
    }
  }`;

const CREATE_BUILD_CREDENTIALS_MUTATION = `
  mutation CreateAndroidAppBuildCredentials(
    $androidAppCredentialsId: ID!,
    $androidAppBuildCredentialsInput: AndroidAppBuildCredentialsInput!
  ) {
    androidAppBuildCredentials {
      createAndroidAppBuildCredentials(
        androidAppCredentialsId: $androidAppCredentialsId,
        androidAppBuildCredentialsInput: $androidAppBuildCredentialsInput
      ) {
        id
        name
        isDefault
      }
    }
  }`;

const SET_KEYSTORE_MUTATION = `
  mutation SetKeystore($id: ID!, $keystoreId: ID!) {
    androidAppBuildCredentials {
      setKeystore(id: $id, keystoreId: $keystoreId) {
        id
        name
      }
    }
  }`;

export async function uploadLocalKeystoreToEas(
  cwd: string,
  projectId: string,
  auth?: EasAuth | null
): Promise<{ id: string; name: string }> {
  if (!projectId) throw new Error('This project is not linked to EAS. Link an EAS project first.');
  const props = readKeystoreProps(cwd);
  if (!props) throw new Error('No local keystore configuration (keystore.properties) found to upload.');

  // Validate the application identifier up front so we fail before any network
  // call or authentication round-trip — EAS cannot register a keystore without it.
  const exp = readExpoConfig(cwd)?.config || {};
  const pkg = exp.android?.package;
  if (!pkg) {
    throw new Error(
      'Missing expo.android.package in your Expo config — EAS cannot register the keystore without the application identifier. ' +
        'Set it in app.json first (or run `doctor` / fix the package name in the UI).'
    );
  }

  const candidatePaths = [
    path.join(cwd, 'android', 'app', props.storeFile),
    path.join(cwd, props.storeFile),
    path.join(cwd, 'credentials', 'android', props.storeFile),
  ];
  const jksPath = candidatePaths.find((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
  if (!jksPath) throw new Error(`Keystore file "${props.storeFile}" was not found on disk.`);

  const fileBytes = fs.readFileSync(jksPath);
  const base64Keystore = fileBytes.toString('base64');
  const type = props.storeFile.endsWith('.p12') || props.storeFile.endsWith('.pfx') ? 'PKCS12' : 'JKS';

  // 1. Fetch App Info (Owner Account & App Credentials)
  const appInfoRes = await easGraphql<any>(GET_APP_INFO_QUERY, { appId: projectId }, auth);
  const appData = appInfoRes?.app?.byId;
  if (!appData || !appData.ownerAccount?.id) {
    throw new Error(`Could not locate EAS project details for project ID "${projectId}".`);
  }
  const accountId = appData.ownerAccount.id;

  // 2. Resolve or Create AndroidAppCredentials Container
  const credsList = appData.androidAppCredentials || [];
  let matched = credsList.find((c: any) => c.applicationIdentifier === pkg);
  let androidAppCredentialsId = matched?.id || credsList[0]?.id || null;

  if (!androidAppCredentialsId) {
    const createCredRes = await easGraphql<any>(
      CREATE_APP_CREDENTIALS_MUTATION,
      { appId: projectId, applicationIdentifier: pkg },
      auth
    );
    androidAppCredentialsId = createCredRes?.androidAppCredentials?.createAndroidAppCredentials?.id || null;
  }

  if (!androidAppCredentialsId) {
    throw new Error('Failed to resolve or create Android App Credentials container on EAS.');
  }

  // 3. Create the AndroidKeystore Object
  const createKsRes = await easGraphql<any>(
    CREATE_KEYSTORE_OBJECT_MUTATION,
    {
      accountId,
      androidKeystoreInput: {
        base64EncodedKeystore: base64Keystore,
        keystorePassword: props.storePassword,
        keyAlias: props.keyAlias,
        keyPassword: props.keyPassword || props.storePassword,
        type,
      },
    },
    auth
  );

  const keystoreId = createKsRes?.androidKeystore?.createAndroidKeystore?.id;
  if (!keystoreId) {
    throw new Error('EAS API did not return a valid keystoreId after upload.');
  }

  // 4. Create Build Credentials binding keystoreId to app (or update if already exists)
  const credentialName = props.keyAlias || 'release';
  try {
    const response = await easGraphql<any>(
      CREATE_BUILD_CREDENTIALS_MUTATION,
      {
        androidAppCredentialsId,
        androidAppBuildCredentialsInput: {
          name: credentialName,
          isDefault: true,
          keystoreId,
        },
      },
      auth
    );
    const created = response?.androidAppBuildCredentials?.createAndroidAppBuildCredentials;
    if (created && created.id) {
      return { id: created.id, name: created.name || credentialName };
    }
  } catch (err: any) {
    if (
      err?.code === 'CREDENTIALS_ANDROID_BUILD_CREDENTIALS_WITH_NAME_ALREADY_EXISTS_FOR_ANDROID_APP_CREDENTIALS' ||
      /already exists/i.test(err?.message || '')
    ) {
      const listRes = await listEasKeystores(projectId, auth);
      const existing = listRes.find((k: EasKeystoreSummary) => k.name === credentialName || k.keyAlias === credentialName) || listRes[0];
      if (existing && existing.buildCredentialsId) {
        const updateRes = await easGraphql<any>(
          SET_KEYSTORE_MUTATION,
          { id: existing.buildCredentialsId, keystoreId },
          auth
        );
        const updated = updateRes?.androidAppBuildCredentials?.setKeystore;
        if (updated && updated.id) {
          return { id: updated.id, name: updated.name || credentialName };
        }
      }
    }
    throw err;
  }

  return { id: keystoreId, name: credentialName };
}
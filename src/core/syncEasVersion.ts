import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import { log } from '../util/log';

const EAS_API = 'api.expo.dev';

function getSessionSecret(): { token?: string; sessionSecret?: string } {
  if (process.env.EXPO_TOKEN) return { token: process.env.EXPO_TOKEN };
  const statePath = path.join(os.homedir(), '.expo', 'state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(
      'No EXPO_TOKEN env var and no ~/.expo/state.json found. Run `eas login` first.'
    );
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const secret = state?.auth?.sessionSecret;
  if (!secret) throw new Error('No sessionSecret in ~/.expo/state.json. Run `eas login` first.');
  return { sessionSecret: secret };
}

export interface SyncEasVersionOpts {
  cwd: string;
}

export async function syncEasVersion({ cwd }: SyncEasVersionOpts): Promise<void> {
  const gradlePath = path.join(cwd, 'android', 'app', 'build.gradle');
  const appJsonPath = path.join(cwd, 'app.json');
  if (!fs.existsSync(gradlePath)) throw new Error(`${gradlePath} not found`);
  if (!fs.existsSync(appJsonPath)) throw new Error(`${appJsonPath} not found`);

  const gradle = fs.readFileSync(gradlePath, 'utf8');
  const m = gradle.match(/\bversionCode\s+(\d+)/);
  if (!m) throw new Error('Could not find versionCode in build.gradle');
  const versionCode = m[1];

  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const projectId: string | undefined = appJson.expo?.extra?.eas?.projectId;
  const applicationId: string | undefined = appJson.expo?.android?.package;
  const storeVersion: string = appJson.expo?.version ?? '1.0.0';
  if (!projectId) {
    log.warn('No expo.extra.eas.projectId in app.json — skipping EAS version sync.');
    return;
  }
  if (!applicationId) throw new Error('Missing expo.android.package in app.json');

  const auth = getSessionSecret();

  const mutation = `
    mutation CreateAppVersionMutation($appVersionInput: AppVersionInput!) {
      appVersion {
        createAppVersion(appVersionInput: $appVersionInput) { id }
      }
    }`;
  const variables = {
    appVersionInput: {
      appId: projectId,
      platform: 'ANDROID',
      applicationIdentifier: applicationId,
      storeVersion,
      buildVersion: String(versionCode),
    },
  };
  const body = JSON.stringify({ query: mutation, variables });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    'expo-client-info': JSON.stringify({ appVersion: '0.0.0', sdkVersion: '0.0.0' }),
  };
  if (auth.sessionSecret) headers['expo-session'] = auth.sessionSecret;
  if (auth.token) headers['authorization'] = `Bearer ${auth.token}`;

  log.info(`Syncing EAS versionCode → ${versionCode} (appId: ${projectId})`);
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      { hostname: EAS_API, path: '/graphql', method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.errors) return reject(new Error(`EAS API: ${JSON.stringify(json.errors)}`));
            log.ok(`EAS remote versionCode set to ${versionCode}`);
            resolve();
          } catch {
            reject(new Error(`Failed to parse EAS response: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

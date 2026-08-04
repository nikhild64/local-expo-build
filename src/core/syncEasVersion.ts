import fs from 'fs';
import path from 'path';
import { log } from '../util/log';
import { easGraphql } from './eas/api';

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
  log.info(`Syncing EAS versionCode → ${versionCode} (appId: ${projectId})`);
  await easGraphql(mutation, variables);
  log.ok(`EAS remote versionCode set to ${versionCode}`);
}

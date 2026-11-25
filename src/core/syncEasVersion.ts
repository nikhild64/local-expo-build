import fs from 'fs';
import path from 'path';
import { log } from '../util/log';
import { easGraphql } from './eas/api';
import { readExpoConfig } from './expoConfig';

export interface SyncEasVersionOpts {
  cwd: string;
}

export async function syncEasVersion({ cwd }: SyncEasVersionOpts): Promise<void> {
  const gradlePath = path.join(cwd, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradlePath)) throw new Error(`${gradlePath} not found`);

  const resolved = readExpoConfig(cwd);
  if (!resolved) {
    throw new Error(`Expo config (app.json or app.config.*) not found or unreadable in ${cwd}`);
  }
  const exp = resolved.config;

  const gradle = fs.readFileSync(gradlePath, 'utf8');
  const m = gradle.match(/\bversionCode\s+(\d+)/);
  if (!m) throw new Error('Could not find versionCode in build.gradle');
  const versionCode = m[1];

  const projectId: string | undefined = exp?.extra?.eas?.projectId;
  const applicationId: string | undefined = exp?.android?.package;
  const storeVersion: string = exp?.version ?? '1.0.0';
  if (!projectId) {
    log.warn('No expo.extra.eas.projectId in Expo config — skipping EAS version sync.');
    return;
  }
  if (!applicationId) throw new Error('Missing expo.android.package in Expo config');

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

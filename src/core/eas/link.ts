import fs from 'fs';
import path from 'path';
import { EasApiError, EasAuth, easGraphql } from './api';
import { invalidateExpoConfigCache } from '../expoConfig';

export interface EasAccount { id: string; name: string }
export interface EasProject { id: string; name: string; slug: string; fullName: string }
export interface EasViewer { username: string; accounts: EasAccount[] }
export const EAS_PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function getEasViewer(auth?: EasAuth | null): Promise<EasViewer> {
  const data = await easGraphql<{ viewer: { username: string; accounts: EasAccount[] } | null }>(
    'query Viewer { viewer { username accounts { id name } } }', {}, auth
  );
  if (!data.viewer) throw new EasApiError('Your EAS session is no longer valid.', { isAuthError: true });
  return { username: data.viewer.username, accounts: data.viewer.accounts || [] };
}

export async function listAccounts(auth?: EasAuth | null): Promise<EasAccount[]> {
  return (await getEasViewer(auth)).accounts;
}

export async function listProjects(accountName: string, auth?: EasAuth | null): Promise<EasProject[]> {
  const data = await easGraphql<{ account: { byName: { apps: EasProject[] } | null } }>(
    'query Projects($accountName: String!) { account { byName(accountName: $accountName) { apps(limit: 50, offset: 0) { id name slug fullName } } } }',
    { accountName }, auth
  );
  return Array.isArray(data.account?.byName?.apps) ? data.account.byName.apps : [];
}

export async function createProject(accountId: string, projectName: string, auth?: EasAuth | null): Promise<EasProject> {
  if (!EAS_PROJECT_NAME.test(projectName)) throw new Error('Project name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.');
  try {
    const data = await easGraphql<{ app: { createApp: EasProject } }>(
      'mutation CreateApp($appInput: AppInput!) { app { createApp(appInput: $appInput) { id name slug fullName } } }',
      { appInput: { accountId, projectName } }, auth
    );
    return data.app.createApp;
  } catch (err: any) {
    if (err instanceof EasApiError && /already exists|duplicate/i.test(err.message)) {
      throw new Error(`A project named ${projectName} already exists in this account — pick it from the list instead.`);
    }
    throw err;
  }
}

export function writeProjectIdToAppJson(cwd: string, projectId: string, overwrite = false): void {
  const appJsonPath = path.join(cwd, 'app.json');
  let json: any;
  if (fs.existsSync(appJsonPath)) {
    try {
      json = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    } catch (err: any) {
      throw new Error(`Could not parse app.json: ${err.message}`);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('app.json must contain a JSON object.');
  } else {
    let name = 'app';
    try { name = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))?.name || name; } catch { /* use default */ }
    const slug = String(name).replace(/[^a-zA-Z0-9._-]/g, '-') || 'app';
    json = { expo: { name, slug } };
  }
  json.expo = json.expo && typeof json.expo === 'object' ? json.expo : {};
  const existing = json.expo.extra?.eas?.projectId;
  if (existing && existing !== projectId && !overwrite) {
    const err: any = new Error(`This project is already linked to EAS project ${existing}. Confirm before replacing it.`);
    err.status = 409;
    throw err;
  }
  json.expo.extra = json.expo.extra && typeof json.expo.extra === 'object' ? json.expo.extra : {};
  json.expo.extra.eas = json.expo.extra.eas && typeof json.expo.extra.eas === 'object' ? json.expo.extra.eas : {};
  json.expo.extra.eas.projectId = projectId;
  fs.writeFileSync(appJsonPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  invalidateExpoConfigCache(cwd);
}
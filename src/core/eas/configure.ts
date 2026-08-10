import fs from 'fs';
import path from 'path';
import { execa } from 'execa';

const DEFAULT_EAS_JSON = {
  cli: { version: '>= 10.0.0', appVersionSource: 'remote' },
  build: {
    development: {
      developmentClient: true,
      distribution: 'internal',
    },
    preview: {
      distribution: 'internal',
    },
    production: {},
  },
};

/**
 * Adds `cli.appVersionSource: "remote"` to an existing eas.json when the key
 * is missing. EAS remote versioning is this tool's whole model — syncEasVersion
 * is authoritative — so `eas build:configure`-created eas.json (which omits the
 * key) must be aligned too. Only adds the single key; never touches build
 * profiles or other settings.
 */
export function ensureRemoteAppVersionSource(cwd: string): void {
  const filePath = path.join(cwd, 'eas.json');
  if (!fs.existsSync(filePath)) return;
  try {
    const easJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!easJson || typeof easJson !== 'object' || easJson.cli?.appVersionSource === 'remote') return;
    easJson.cli = { ...(easJson.cli ?? {}), appVersionSource: 'remote' };
    fs.writeFileSync(filePath, JSON.stringify(easJson, null, 2) + '\n', 'utf8');
  } catch {
    // Leave malformed eas.json untouched.
  }
}

export async function configureEasProject(cwd: string): Promise<{ created: boolean; path: string }> {
  const filePath = path.join(cwd, 'eas.json');
  if (fs.existsSync(filePath)) {
    ensureRemoteAppVersionSource(cwd);
    return { created: false, path: filePath };
  }
  fs.writeFileSync(filePath, JSON.stringify(DEFAULT_EAS_JSON, null, 2) + '\n', 'utf8');
  return { created: true, path: filePath };
}
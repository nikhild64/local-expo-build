import fs from 'fs';
import path from 'path';
import { execa } from 'execa';

export async function configureEasProject(cwd: string): Promise<{ created: boolean; path: string }> {
  const filePath = path.join(cwd, 'eas.json');
  if (fs.existsSync(filePath)) return { created: false, path: filePath };
  try {
    await execa('eas', ['build:configure', '--platform', 'android'], {
      cwd,
      timeout: 120_000,
      stdio: 'pipe',
      env: { ...process.env, CI: '1' },
    });
  } catch (err: any) {
    const detail = err?.stderr || err?.shortMessage || err?.message || String(err);
    throw new Error(
      `eas build:configure failed: ${detail}. ` +
        'Install eas-cli and authenticate with `eas login`, then try again.'
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error('eas build:configure finished without creating eas.json.');
  }
  return { created: true, path: filePath };
}
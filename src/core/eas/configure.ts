import fs from 'fs';
import path from 'path';
import { execa } from 'execa';

const DEFAULT_EAS_JSON = {
  cli: { version: '>= 10.0.0' },
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

export async function configureEasProject(cwd: string): Promise<{ created: boolean; path: string }> {
  const filePath = path.join(cwd, 'eas.json');
  if (fs.existsSync(filePath)) return { created: false, path: filePath };
  fs.writeFileSync(filePath, JSON.stringify(DEFAULT_EAS_JSON, null, 2) + '\n', 'utf8');
  return { created: true, path: filePath };
}
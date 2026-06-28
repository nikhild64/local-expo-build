import fs from 'fs';
import path from 'path';
import semver from 'semver';

export interface SdkInfo {
  major: number;
  raw: string;
}

export function detectExpoSdk(cwd: string): SdkInfo {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}. Is this an Expo project?`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const raw: string | undefined =
    pkg.dependencies?.expo || pkg.devDependencies?.expo;
  if (!raw) {
    throw new Error(`"expo" not found in package.json dependencies at ${pkgPath}`);
  }
  const coerced = semver.coerce(raw);
  if (!coerced) {
    throw new Error(`Could not parse Expo SDK version from "${raw}"`);
  }
  return { major: coerced.major, raw };
}

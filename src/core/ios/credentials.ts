import fs from 'fs';
import path from 'path';

/**
 * Shape of the `ios` section of credentials.json as written by
 * `eas credentials` → "Download credentials from EAS to credentials.json".
 * Reference: https://docs.expo.dev/app-signing/local-credentials/
 */
export interface IosCredentials {
  /** Project-relative path to the .p12 distribution certificate. */
  distributionCertificatePath: string;
  /** Password for the .p12 file. */
  distributionCertificatePassword: string;
  /** Project-relative path to the .mobileprovision provisioning profile. */
  provisioningProfilePath: string;
  /** Absolute resolved paths (filled in by the reader for convenience). */
  absDistributionCertificatePath: string;
  absProvisioningProfilePath: string;
}

/**
 * Reads + validates the iOS section of credentials.json. Returns null if any
 * of the four required fields is missing or if either referenced file
 * doesn't exist on disk.
 *
 * We deliberately do NOT throw on missing — the caller decides whether to
 * prompt the user or error out. This mirrors `findRehydrateCandidate` for
 * the Android side.
 */
export function readIosCredentials(cwd: string): IosCredentials | null {
  const credPath = path.join(cwd, 'credentials.json');
  if (!fs.existsSync(credPath)) return null;

  let cred: any;
  try {
    cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch {
    return null;
  }

  const ios = cred?.ios;
  const distPath =
    ios?.distributionCertificate?.path ?? ios?.distributionCertificatePath;
  const distPassword =
    ios?.distributionCertificate?.password ?? ios?.distributionCertificatePassword;
  const profilePath = ios?.provisioningProfilePath;

  if (
    typeof distPath !== 'string' ||
    typeof distPassword !== 'string' ||
    typeof profilePath !== 'string'
  ) {
    return null;
  }

  const absDist = path.resolve(cwd, distPath);
  const absProfile = path.resolve(cwd, profilePath);
  if (!fs.existsSync(absDist) || !fs.existsSync(absProfile)) return null;

  return {
    distributionCertificatePath: distPath,
    distributionCertificatePassword: distPassword,
    provisioningProfilePath: profilePath,
    absDistributionCertificatePath: absDist,
    absProvisioningProfilePath: absProfile,
  };
}

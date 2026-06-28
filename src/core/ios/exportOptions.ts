import fs from 'fs';
import path from 'path';

/**
 * Apple's distribution methods for `xcodebuild -exportArchive`. Each one
 * implies a different signing certificate + provisioning profile type:
 *  - app-store:   App Store / TestFlight distribution. Most common for releases.
 *  - ad-hoc:      Internal distribution to a fixed list of registered devices.
 *  - development: Local debugging / dev-team-only.
 *  - enterprise:  In-house distribution under an Enterprise Apple Developer account.
 */
export type IosExportMethod = 'app-store' | 'ad-hoc' | 'development' | 'enterprise';

export interface ExportOptionsArgs {
  method: IosExportMethod;
  /** 10-character Apple team identifier (visible in the Apple Developer portal). */
  teamId?: string;
  /** App's bundle identifier (e.g. com.example.app). Required for manual signing. */
  bundleIdentifier?: string;
  /** Provisioning profile name as listed in the .mobileprovision (NOT a path). */
  provisioningProfileName?: string;
  /** When true, omits compileBitcode (Apple deprecated bitcode in Xcode 14+). */
  stripBitcode?: boolean;
}

/**
 * Generates the minimal exportOptions.plist content for
 * `xcodebuild -exportArchive`. We use the manual signing style with
 * provisioningProfiles mapping when a team + bundle id are supplied; otherwise
 * we fall back to automatic signing, which works for development/ad-hoc when
 * the Apple ID is signed into Xcode.
 *
 * Schema reference: https://developer.apple.com/library/archive/documentation/IDEs/Conceptual/AppDistributionGuide/
 * Run `xcodebuild -h` on a Mac for the per-key list — this file picks the
 * keys we know are universally supported across Xcode 14, 15, 16.
 */
export function buildExportOptionsPlist(args: ExportOptionsArgs): string {
  const parts: string[] = [];
  parts.push(`<key>method</key><string>${escape(args.method)}</string>`);

  if (args.teamId) {
    parts.push(`<key>teamID</key><string>${escape(args.teamId)}</string>`);
    parts.push(`<key>signingStyle</key><string>manual</string>`);
  } else {
    parts.push(`<key>signingStyle</key><string>automatic</string>`);
  }

  if (args.bundleIdentifier && args.provisioningProfileName) {
    parts.push(
      `<key>provisioningProfiles</key><dict>` +
        `<key>${escape(args.bundleIdentifier)}</key>` +
        `<string>${escape(args.provisioningProfileName)}</string>` +
        `</dict>`
    );
  }

  if (args.stripBitcode !== false) {
    parts.push(`<key>compileBitcode</key><false/>`);
  }

  // uploadSymbols defaults to true on app-store but causes failures on
  // ad-hoc/development — explicit false avoids that.
  if (args.method !== 'app-store') {
    parts.push(`<key>uploadSymbols</key><false/>`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n  ${parts.join('\n  ')}\n</dict></plist>\n`
  );
}

/**
 * Writes the plist to `<cwd>/ios/build/export-options.plist` and returns the
 * absolute path. Creates the build directory if missing. Overwrites any
 * existing file (the plist is regenerated every build to pick up the latest
 * method/teamId/profile).
 */
export function writeExportOptionsPlist(cwd: string, args: ExportOptionsArgs): string {
  const buildDir = path.join(cwd, 'ios', 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const filePath = path.join(buildDir, 'export-options.plist');
  fs.writeFileSync(filePath, buildExportOptionsPlist(args), 'utf8');
  return filePath;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

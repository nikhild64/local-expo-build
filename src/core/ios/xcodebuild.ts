import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { log } from '../../util/log';

export interface ArchiveOpts {
  cwd: string;
  workspacePath: string;
  scheme: string;
  configuration?: string; // default 'Release'
  archivePath: string; // absolute output path for the .xcarchive
}

/**
 * Runs `xcodebuild ... archive`. Inherits stdio so the user sees Xcode's
 * native progress output. Throws (with `execa`'s rich error) on non-zero
 * exit. Does not interpret Xcode errors — the user reads them directly.
 */
export async function xcodebuildArchive(opts: ArchiveOpts): Promise<void> {
  const cfg = opts.configuration || 'Release';
  log.info(`xcodebuild archive (scheme=${opts.scheme}, configuration=${cfg})`);
  await execa(
    'xcodebuild',
    [
      '-workspace', opts.workspacePath,
      '-scheme', opts.scheme,
      '-configuration', cfg,
      '-archivePath', opts.archivePath,
      'archive',
      '-quiet', // suppress per-file compilation chatter; errors still print
    ],
    { cwd: opts.cwd, stdio: 'inherit' }
  );
}

export interface ExportOpts {
  cwd: string;
  archivePath: string;
  exportPath: string; // absolute output directory for the .ipa
  exportOptionsPlistPath: string;
}

/**
 * Runs `xcodebuild -exportArchive` to produce the .ipa from a .xcarchive
 * using the supplied export-options.plist.
 */
export async function xcodebuildExport(opts: ExportOpts): Promise<string> {
  log.info(`xcodebuild -exportArchive (out=${path.relative(opts.cwd, opts.exportPath)})`);
  await execa(
    'xcodebuild',
    [
      '-exportArchive',
      '-archivePath', opts.archivePath,
      '-exportPath', opts.exportPath,
      '-exportOptionsPlist', opts.exportOptionsPlistPath,
    ],
    { cwd: opts.cwd, stdio: 'inherit' }
  );

  // xcodebuild names the exported .ipa <SchemeName>.ipa — find it without
  // hardcoding the name so we work regardless of scheme.
  const ipas = fs.readdirSync(opts.exportPath).filter((f) => f.endsWith('.ipa'));
  if (ipas.length === 0) {
    throw new Error(
      `xcodebuild reported success but no .ipa was found in ${opts.exportPath}. ` +
        `Check the xcodebuild output above for warnings.`
    );
  }
  if (ipas.length > 1) {
    log.warn(
      `Multiple .ipa files found in ${opts.exportPath}: ${ipas.join(', ')}. ` +
        `Returning the first one. (This usually means a previous build left stale artifacts; delete the export dir and rebuild.)`
    );
  }
  return path.join(opts.exportPath, ipas[0]);
}

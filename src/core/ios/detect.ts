import fs from 'fs';
import path from 'path';

/**
 * Information about the Xcode project layout that `xcodebuild` needs to
 * find the right targets.
 */
export interface IosProjectInfo {
  /** Absolute path to the .xcworkspace directory. */
  workspacePath: string;
  /** Workspace basename without extension (typically also the scheme name). */
  workspaceName: string;
  /**
   * Best-guess scheme name. Expo's prebuild names the workspace and the
   * scheme identically, so workspaceName is almost always correct. Override
   * via --scheme if a project uses a non-standard layout.
   */
  inferredScheme: string;
}

/**
 * Finds the .xcworkspace produced by `expo prebuild --platform ios`. Returns
 * null when ios/ is missing or doesn't contain exactly one workspace (in
 * which case the caller should ask the user to pass --workspace explicitly).
 */
export function detectIosProject(cwd: string): IosProjectInfo | null {
  const iosDir = path.join(cwd, 'ios');
  if (!fs.existsSync(iosDir) || !fs.statSync(iosDir).isDirectory()) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(iosDir);
  } catch {
    return null;
  }
  const workspaces = entries.filter((e) => e.endsWith('.xcworkspace'));
  if (workspaces.length !== 1) return null;

  const workspacePath = path.join(iosDir, workspaces[0]);
  const workspaceName = path.basename(workspaces[0], '.xcworkspace');
  return {
    workspacePath,
    workspaceName,
    inferredScheme: workspaceName,
  };
}

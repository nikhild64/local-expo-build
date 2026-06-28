import kleur from 'kleur';

/**
 * Throws with a clear, actionable error if the current machine isn't macOS.
 * iOS builds genuinely cannot run anywhere else — Apple ships `xcodebuild`
 * only on macOS. Call this at the top of every iOS code path so we fail
 * fast with a useful message instead of a cryptic "command not found".
 */
export function assertMacOS(featureName: string): void {
  if (process.platform === 'darwin') return;
  throw new Error(
    `${featureName} requires macOS — Apple does not ship xcodebuild for ` +
      `${process.platform === 'win32' ? 'Windows' : process.platform}.\n` +
      `iOS builds are only possible on a Mac. For cross-platform release ` +
      `automation, use \`eas build --platform ios\` (cloud) on a non-Mac host.`
  );
}

/**
 * Prints a single-line yellow banner stating that iOS support is
 * experimental and untested by the maintainer in this release. We want users
 * to know that bug reports are expected and that they may need to file
 * issues / PRs to get full polish — but we don't want to block usage with
 * an explicit opt-in flag (that gets annoying after the first run).
 */
export function printIosExperimentalBanner(): void {
  console.warn(
    kleur.yellow(
      '! iOS support is EXPERIMENTAL — not validated by the maintainer on macOS. ' +
        'Please file issues at https://github.com/nikhild64/local-expo-build/issues'
    )
  );
}

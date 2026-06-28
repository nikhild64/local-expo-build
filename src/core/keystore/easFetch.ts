import { execa } from 'execa';
import { confirm } from '@inquirer/prompts';
import { log } from '../../util/log';
import { detectEasLink, isEasReady } from '../easLink';

/**
 * Fetches Android signing credentials from EAS.
 *
 * EAS CLI does not expose a stable non-interactive keystore export, so we run
 * `eas credentials --platform android` interactively and ask the user to
 * download the .jks via the menu. After download, they re-run
 * `expo-local-build keystore import <path>`.
 *
 * Pre-flight: `eas credentials` requires BOTH a projectId (linked via
 * `eas init`) AND `eas.json` (created via `eas build:configure`). We check
 * each independently and offer to run the appropriate command so the user
 * doesn't see a cryptic "credentials command failed".
 */
export async function fetchKeystoreFromEas(cwd: string): Promise<void> {
  await ensureEasReady(cwd);

  log.info('Launching EAS credentials manager. Choose "Download Keystore" to save the .jks locally.');
  log.dim('When done, re-run: expo-local-build keystore import <path-to-downloaded.jks>');
  try {
    await execa('eas', ['credentials', '--platform', 'android'], { cwd, stdio: 'inherit' });
  } catch (err: any) {
    throw new Error(
      `eas credentials failed: ${err?.shortMessage || err?.message || err}. ` +
        `Ensure EAS CLI is installed (npm i -g eas-cli) and you are logged in (eas login).`
    );
  }
  log.warn(
    'EAS CLI does not provide a stable non-interactive keystore export. ' +
      'After downloading, run `expo-local-build keystore import <path>` to register it.'
  );
}

async function ensureEasReady(cwd: string): Promise<void> {
  let link = detectEasLink(cwd);
  if (isEasReady(link)) return;

  if (link.kind === 'no-expo-config') {
    throw new Error(
      `This does not look like an Expo project (no app.json or app.config.*). ` +
        `Run \`expo-local-build\` inside an Expo project root, or pass --cwd <path>.`
    );
  }

  const interactive = process.stdin.isTTY;

  // Step 1: project not linked (no projectId in static config) — needs `eas init`.
  if (link.kind === 'not-linked') {
    const reason = link.hasAppJson
      ? 'app.json has no expo.extra.eas.projectId'
      : 'no app.json with an EAS projectId';
    log.warn(`EAS project not linked: ${reason}.`);
    log.dim('Running `eas init` will link this project to an EAS account and write the projectId.');

    if (!interactive) {
      throw new Error(
        `EAS project not linked. Run \`eas init\` in ${cwd}, then re-run this command.`
      );
    }
    const yes = await confirm({
      message: 'Run `eas init` now to link this project?',
      default: true,
    });
    if (!yes) {
      throw new Error('Aborted. Run `eas init` manually, then re-run `expo-local-build keystore fetch`.');
    }
    await runEas(cwd, ['init'], 'eas init');
    link = detectEasLink(cwd);
    if (isEasReady(link)) {
      log.ok('EAS link complete. Continuing with credentials fetch...');
      return;
    }
  }

  // Step 2: linked (or dynamic) but eas.json is missing — needs `eas build:configure`.
  if (link.kind === 'no-expo-config') {
    throw new Error(
      'Lost track of Expo config after `eas init`. Please re-run `expo-local-build keystore fetch`.'
    );
  }
  if (link.kind === 'dynamic-unreadable') {
    throw new Error(
      'app.config.* exists but could not be resolved. Install Expo CLI in your project ' +
        '(`npm install`) and retry, or add `expo.extra.eas.projectId` + `eas.json` manually.'
    );
  }
  if (!link.hasEasJson) {
    log.warn('eas.json is missing — required by `eas credentials`.');
    log.dim('Running `eas build:configure` will create eas.json with default build profiles.');

    if (!interactive) {
      throw new Error(
        `eas.json not found. Run \`eas build:configure --platform android\` in ${cwd}, ` +
          `then re-run this command.`
      );
    }
    const yes = await confirm({
      message: 'Run `eas build:configure --platform android` now to create eas.json?',
      default: true,
    });
    if (!yes) {
      throw new Error(
        'Aborted. Run `eas build:configure --platform android` manually, ' +
          'then re-run `expo-local-build keystore fetch`.'
      );
    }
    await runEas(cwd, ['build:configure', '--platform', 'android'], 'eas build:configure');
    link = detectEasLink(cwd);
  }

  if (!isEasReady(link)) {
    throw new Error(
      'EAS setup finished but the project still does not appear ready. ' +
        'Verify eas.json exists and (for static configs) app.json has expo.extra.eas.projectId, then retry.'
    );
  }
  log.ok('EAS is ready. Continuing with credentials fetch...');
}

async function runEas(cwd: string, args: string[], label: string): Promise<void> {
  try {
    await execa('eas', args, { cwd, stdio: 'inherit' });
  } catch (err: any) {
    throw new Error(
      `${label} failed: ${err?.shortMessage || err?.message || err}. ` +
        `Ensure EAS CLI is installed (npm i -g eas-cli) and you are logged in (eas login).`
    );
  }
}

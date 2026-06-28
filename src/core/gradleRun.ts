import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { log } from '../util/log';

export interface GradleRunOpts {
  cwd: string;
  task: 'assembleRelease' | 'bundleRelease';
}

export async function gradleRun({ cwd, task }: GradleRunOpts): Promise<string> {
  const androidDir = path.join(cwd, 'android');
  const isWin = process.platform === 'win32';
  const wrapper = isWin ? 'gradlew.bat' : './gradlew';
  if (!fs.existsSync(path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew'))) {
    throw new Error(`Gradle wrapper not found in ${androidDir}. Run prebuild first.`);
  }
  log.info(`gradle ${task} (cwd: ${androidDir})`);
  await execa(wrapper, [task], { cwd: androidDir, stdio: 'inherit', shell: isWin });

  const artifact =
    task === 'bundleRelease'
      ? path.join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')
      : path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (fs.existsSync(artifact)) {
    log.ok(`Artifact: ${artifact}`);
  } else {
    log.warn(`Expected artifact not found at ${artifact}`);
  }
  return artifact;
}

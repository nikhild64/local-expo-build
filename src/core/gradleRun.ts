import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execa } from 'execa';
import { log } from '../util/log';
import { parseRamMb } from '../util/ram';

export interface GradleRunOpts {
  cwd: string;
  task: 'assembleRelease' | 'bundleRelease' | 'assembleDebug';
  maxRam?: string;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export async function gradleRun({ cwd, task, maxRam, onLine, signal }: GradleRunOpts): Promise<string> {
  const androidDir = path.join(cwd, 'android');
  const isWin = process.platform === 'win32';
  const wrapper = isWin ? 'gradlew.bat' : './gradlew';
  if (!fs.existsSync(path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew'))) {
    throw new Error(`Gradle wrapper not found in ${androidDir}. Run prebuild first.`);
  }

  const ramMb = parseRamMb(maxRam);
  const env: Record<string, string | undefined> = { ...process.env };
  if (ramMb) {
    const metaspace = ramMb >= 8192 ? '1536m' : '1024m';
    env.GRADLE_OPTS = `-Xmx${ramMb}m -XX:MaxMetaspaceSize=${metaspace} -XX:+UseParallelGC`;
    env.NODE_OPTIONS = `--max-old-space-size=${ramMb}`;
    log.info(`[RAM] Gradle JVM allocated -Xmx${ramMb}m | Node heap: ${ramMb}MB`);
  }

  log.info(`gradle ${task} (cwd: ${androidDir})`);
  if (onLine) {
    const proc = execa(wrapper, [task], {
      cwd: androidDir,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: isWin,
      cancelSignal: signal,
    });
    let rl: readline.Interface | undefined;
    let rlErr: readline.Interface | undefined;
    if (proc.stdout) {
      rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (l) => {
        process.stdout.write(l + '\n');
        onLine(l);
      });
    }
    if (proc.stderr) {
      rlErr = readline.createInterface({ input: proc.stderr });
      rlErr.on('line', (l) => {
        process.stderr.write(l + '\n');
        onLine(l);
      });
    }
    try {
      await proc;
    } finally {
      rl?.close();
      rlErr?.close();
    }
  } else {
    await execa(wrapper, [task], { cwd: androidDir, env, stdio: 'inherit', shell: isWin, cancelSignal: signal });
  }

  const artifact =
    task === 'bundleRelease'
      ? path.join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')
      : task === 'assembleDebug'
        ? path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
        : path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (fs.existsSync(artifact)) {
    log.ok(`Artifact: ${artifact}`);
  } else {
    log.warn(`Expected artifact not found at ${artifact}`);
  }
  return artifact;
}

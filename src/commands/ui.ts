import { Command } from 'commander';
import { execa } from 'execa';
import { getCtx } from '../util/ctx';
import { log } from '../util/log';
import { startUiServer } from '../server/server';

export function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'win32') {
    execa('cmd', ['/c', 'start', '', url], { reject: false });
  } else if (platform === 'darwin') {
    execa('open', [url], { reject: false });
  } else {
    execa('xdg-open', [url], { reject: false });
  }
}

export function registerUiCommand(program: Command): void {
  program
    .command('ui')
    .description('Launch local browser UI for Android builds, Doctor, Keystore, and one-click EAS actions')
    .option('--port <number>', 'port for local web server', '3847')
    .option('--no-open', 'do not auto-open the browser')
    .option('--logs', 'mirror safe UI server and Android build logs to this terminal')
    .action(async (opts, cmd) => {
      const ctx = getCtx(cmd);
      const port = parseInt(opts.port, 10) || 3847;

      log.step('local-expo-build ui');
      log.dim('Starting local browser UI (localhost only)...');

      const serverInstance = await startUiServer({
        cwd: ctx.cwd,
        port,
        dryRun: ctx.dryRun,
        logs: !!opts.logs,
      });

      if (opts.open !== false) {
        log.info(`Opening browser at ${serverInstance.url}`);
        openBrowser(serverInstance.url);
      }

      log.dim('Press Ctrl+C to stop the UI server.');
      if (opts.logs) log.dim('Terminal log mirroring enabled (credentials and tokens are redacted).');

      // Keep Node process running until SIGINT / SIGTERM
      await new Promise<void>((resolve) => {
        let isStopping = false;
        const handleShutdown = async (signal: string) => {
          if (isStopping) {
            process.exit(0);
          }
          isStopping = true;
          log.info(`\nStopping UI server (${signal})...`);

          const safetyTimer = setTimeout(() => {
            process.exit(0);
          }, 500);
          safetyTimer.unref();

          try {
            await serverInstance.close();
          } catch {
            // ignore
          }
          resolve();
          process.exit(0);
        };

        process.on('SIGINT', () => handleShutdown('SIGINT'));
        process.on('SIGTERM', () => handleShutdown('SIGTERM'));
      });
    });
}

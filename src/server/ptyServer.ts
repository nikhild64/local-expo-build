import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import path from 'path';

let ptyModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ptyModule = require('@lydell/node-pty');
} catch {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyModule = require('node-pty');
  } catch {
    ptyModule = null;
  }
}

export const ALLOWLISTED_COMMANDS: Record<string, { cmd: string; args: string[] }> = {
  'eas-init': { cmd: 'eas', args: ['init'] },
  'eas-configure': { cmd: 'eas', args: ['build:configure', '--platform', 'android'] },
  'eas-credentials': { cmd: 'eas', args: ['credentials', '--platform', 'android'] },
};

export interface PtyServerOptions {
  cwd: string;
  onPtyExit?: (commandId: string, exitCode: number) => void;
}

export class PtyManager {
  private activePty: any = null;
  private activeCommandId: string | null = null;

  public isPtyAvailable(): boolean {
    return ptyModule !== null;
  }

  public setupPtyWebSocket(wss: WebSocketServer, opts: PtyServerOptions): void {
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      if (!this.isPtyAvailable()) {
        ws.send(
          JSON.stringify({
            type: 'pty-unavailable',
            message:
              'Native PTY (@lydell/node-pty) is not installed. To run eas interactively in the browser, install @lydell/node-pty or node-pty, or use your host terminal.',
          })
        );
      }

      ws.on('message', (message: string | Buffer) => {
        try {
          const payload = JSON.parse(message.toString());
          if (payload.type === 'start') {
            const commandId = payload.command;
            const target = ALLOWLISTED_COMMANDS[commandId];
            if (!target) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: `Command "${commandId}" is not allowlisted.`,
                })
              );
              return;
            }

            if (!this.isPtyAvailable()) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message:
                    'PTY is not available on this server. Please install @lydell/node-pty or use host terminal.',
                })
              );
              return;
            }

            if (this.activePty) {
              try {
                this.activePty.kill();
              } catch {
                // ignore
              }
              this.activePty = null;
            }

            const isWin = process.platform === 'win32';
            const executable = isWin ? `${target.cmd}.cmd` : target.cmd;

            this.activeCommandId = commandId;
            try {
              this.activePty = ptyModule!.spawn(executable, target.args, {
                name: 'xterm-color',
                cols: payload.cols || 80,
                rows: payload.rows || 24,
                cwd: opts.cwd,
                env: process.env as Record<string, string>,
              });
            } catch (err: any) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: `Failed to spawn ${target.cmd}: ${err?.message || err}`,
                })
              );
              return;
            }

            ws.send(
              JSON.stringify({
                type: 'started',
                command: commandId,
              })
            );

            this.activePty.onData((data: string) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'output', data }));
              }
            });

            this.activePty.onExit(({ exitCode }: { exitCode: number }) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'exit', exitCode }));
              }
              const finishedCmd = this.activeCommandId;
              this.activePty = null;
              this.activeCommandId = null;
              if (finishedCmd && opts.onPtyExit) {
                opts.onPtyExit(finishedCmd, exitCode);
              }
            });
          } else if (payload.type === 'input') {
            if (this.activePty) {
              this.activePty.write(payload.data);
            }
          } else if (payload.type === 'resize') {
            if (this.activePty && payload.cols && payload.rows) {
              try {
                this.activePty.resize(payload.cols, payload.rows);
              } catch {
                // ignore
              }
            }
          } else if (payload.type === 'stop') {
            if (this.activePty) {
              try {
                this.activePty.kill();
              } catch {
                // ignore
              }
              this.activePty = null;
              this.activeCommandId = null;
            }
          }
        } catch (err: any) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: `Invalid WS payload: ${err?.message || err}`,
            })
          );
        }
      });

      ws.on('close', () => {
        // Leave PTY or cleanup if needed
      });
    });
  }

  public close(): void {
    if (this.activePty) {
      try {
        this.activePty.kill();
      } catch {
        // ignore
      }
      this.activePty = null;
      this.activeCommandId = null;
    }
  }
}

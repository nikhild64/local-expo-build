import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import Busboy from 'busboy';
import { WebSocketServer } from 'ws';
import { log } from '../util/log';
import { runAndroidBuild } from '../core/androidBuild';
import { collectDoctorChecks, setAndroidPackage, rehydrateKeystore } from '../commands/doctor';
import { readKeystoreProps } from '../core/setupSigning';
import {
  generateKeystore,
  importExistingKeystore,
  rehydrateFromCredentialsJson,
  findRehydrateCandidate,
} from '../core/keystore';
import { detectEasLink, isEasReady } from '../core/easLink';
import { PtyManager } from './ptyServer';

export interface UiServerOpts {
  cwd: string;
  port?: number;
  dryRun?: boolean;
  openBrowser?: boolean;
}

export interface UiServerInstance {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function findAvailablePort(startPort: number): Promise<number> {
  let p = startPort;
  while (p < startPort + 50) {
    const isFree = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port: p }, () => {
        server.close(() => resolve(true));
      });
    });
    if (isFree) return p;
    p++;
  }
  throw new Error(`Could not find an available port in range ${startPort}..${startPort + 50}`);
}

export async function startUiServer(opts: UiServerOpts): Promise<UiServerInstance> {
  const cwd = path.resolve(opts.cwd);
  const preferredPort = opts.port || 3847;
  const actualPort = await findAvailablePort(preferredPort);
  const dryRun = !!opts.dryRun;

  let activeBuild: { status: 'building'; startedAt: string } | null = null;
  const sseClients: Set<ServerResponse> = new Set();
  const ptyManager = new PtyManager();

  const broadcastSse = (event: string, data: any) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(msg);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const uiDir = path.resolve(__dirname, '..', '..', 'ui');

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${actualPort}`);
    const pathname = parsedUrl.pathname;

    // Security CORS & headers (Localhost only)
    const origin = req.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        if (originUrl.hostname === '127.0.0.1' || originUrl.hostname === 'localhost') {
          res.setHeader('Access-Control-Allow-Origin', origin);
        }
      } catch {
        // ignore
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── SSE Endpoint ──
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // ── REST API Routes ──
    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');

      try {
        if (req.method === 'GET' && pathname === '/api/status') {
          const easLink = detectEasLink(cwd);
          res.writeHead(200);
          res.end(
            JSON.stringify({
              cwd,
              port: actualPort,
              dryRun,
              buildStatus: activeBuild ? 'building' : 'idle',
              ptyAvailable: ptyManager.isPtyAvailable(),
              easReady: isEasReady(easLink),
              keystoreProps: readKeystoreProps(cwd),
            })
          );
          return;
        }

        if (req.method === 'GET' && pathname === '/api/doctor') {
          const summary = await collectDoctorChecks(cwd);
          res.writeHead(200);
          res.end(JSON.stringify(summary));
          return;
        }

        if (req.method === 'POST' && pathname === '/api/doctor/fix-package') {
          const body = await parseJsonBody(req);
          if (!body.packageName) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'packageName is required' }));
            return;
          }
          setAndroidPackage(cwd, body.packageName);
          broadcastSse('doctor-updated', {});
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, packageName: body.packageName }));
          return;
        }

        if (req.method === 'POST' && pathname === '/api/doctor/rehydrate') {
          await rehydrateKeystore(cwd);
          broadcastSse('keystore-updated', {});
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
          return;
        }

        if (req.method === 'GET' && pathname === '/api/keystore/status') {
          const props = readKeystoreProps(cwd);
          const candidate = findRehydrateCandidate(cwd);
          res.writeHead(200);
          res.end(
            JSON.stringify({
              configured: !!props,
              props,
              rehydrateCandidate: candidate
                ? {
                    storeFile: candidate.storeFile,
                    keyAlias: candidate.keyAlias,
                    jksSource: path.relative(cwd, candidate.jksSourceAbs),
                  }
                : null,
            })
          );
          return;
        }

        if (req.method === 'POST' && pathname === '/api/keystore/setup') {
          const body = await parseJsonBody(req);
          const provider = body.provider;

          if (provider === 'generate') {
            await generateKeystore(cwd, body.params || {});
          } else if (provider === 'import') {
            await importExistingKeystore(cwd, body.params || {});
          } else if (provider === 'rehydrate') {
            await rehydrateFromCredentialsJson(cwd, body.params || {});
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `Unsupported provider "${provider}"` }));
            return;
          }

          broadcastSse('keystore-updated', {});
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
          return;
        }

        if (req.method === 'POST' && pathname === '/api/keystore/upload') {
          const bb = Busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024 } });
          let tmpPath = '';
          let keyAlias = '';
          let storePassword = '';
          let keyPassword = '';
          let uploadError: string | null = null;
          let wsStream: fs.WriteStream | null = null;

          bb.on('file', (fieldname, file, info) => {
            const { filename } = info;
            const ext = path.extname(filename).toLowerCase();
            if (ext !== '.jks' && ext !== '.keystore') {
              uploadError = 'Invalid file extension. Only .jks and .keystore files are accepted.';
              file.resume();
              return;
            }
            tmpPath = path.join(os.tmpdir(), `upload-${Date.now()}-${path.basename(filename)}`);
            wsStream = fs.createWriteStream(tmpPath);
            wsStream.on('error', (err) => {
              uploadError = err?.message || String(err);
            });
            file.pipe(wsStream);
          });

          bb.on('field', (name, val) => {
            if (name === 'keyAlias') keyAlias = val;
            if (name === 'storePassword') storePassword = val;
            if (name === 'keyPassword') keyPassword = val;
          });

          bb.on('error', (err: any) => {
            if (tmpPath && fs.existsSync(tmpPath)) {
              try { fs.unlinkSync(tmpPath); } catch {}
            }
            uploadError = err?.message || String(err);
          });

          bb.on('finish', async () => {
            if (uploadError) {
              if (tmpPath && fs.existsSync(tmpPath)) {
                try { fs.unlinkSync(tmpPath); } catch {}
              }
              res.writeHead(400);
              res.end(JSON.stringify({ error: uploadError }));
              return;
            }
            if (!tmpPath || !fs.existsSync(tmpPath)) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'No .jks file uploaded' }));
              return;
            }

            try {
              await importExistingKeystore(cwd, {
                srcPath: tmpPath,
                keyAlias: keyAlias || undefined,
                storePassword: storePassword || undefined,
                keyPassword: keyPassword || undefined,
              });
              if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
              broadcastSse('keystore-updated', {});
              res.writeHead(200);
              res.end(JSON.stringify({ success: true }));
            } catch (err: any) {
              if (fs.existsSync(tmpPath)) {
                try { fs.unlinkSync(tmpPath); } catch {}
              }
              res.writeHead(500);
              res.end(JSON.stringify({ error: err?.message || String(err) }));
            }
          });

          req.pipe(bb);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/build') {
          if (activeBuild) {
            res.writeHead(409);
            res.end(JSON.stringify({ error: 'A build is already in progress.' }));
            return;
          }

          const ksProps = readKeystoreProps(cwd);
          if (!ksProps) {
            res.writeHead(409);
            res.end(
              JSON.stringify({
                error:
                  'Signing keystore not configured (keystore.properties missing or incomplete). Please set up your keystore in the Keystore tab before building.',
              })
            );
            return;
          }

          const body = await parseJsonBody(req);
          activeBuild = { status: 'building', startedAt: new Date().toISOString() };
          broadcastSse('build-start', { kind: body.aab ? 'AAB' : 'APK' });

          res.writeHead(202);
          res.end(JSON.stringify({ status: 'started' }));

          // Execute build asynchronously
          (async () => {
            try {
              const result = await runAndroidBuild({
                cwd,
                apk: body.apk,
                aab: body.aab,
                profile: body.profile || 'production',
                clean: !!body.clean,
                prebuild: body.prebuild !== false,
                bump: body.bump !== false,
                sync: body.sync !== false,
                dryRun,
                ensureKeystoreMode: 'required-existing',
                onLine: (line) => broadcastSse('log', { line }),
                logger: {
                  step: (msg) => broadcastSse('step', { message: msg }),
                  ok: (msg) => broadcastSse('log', { line: `[OK] ${msg}` }),
                  info: (msg) => broadcastSse('log', { line: `[INFO] ${msg}` }),
                  warn: (msg) => broadcastSse('log', { line: `[WARN] ${msg}` }),
                  dim: (msg) => broadcastSse('log', { line: `[DIM] ${msg}` }),
                  error: (msg) => broadcastSse('log', { line: `[ERR] ${msg}` }),
                },
              });
              broadcastSse('build-complete', { success: true, artifact: result.artifact, kind: result.kind });
            } catch (err: any) {
              broadcastSse('build-complete', { success: false, error: err?.message || String(err) });
            } finally {
              activeBuild = null;
            }
          })();

          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: `API route not found: ${pathname}` }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err?.message || String(err) }));
      }
      return;
    }

    // ── Static Files (ui/) ──
    let relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
    let filePath = path.resolve(uiDir, relPath);

    // Security: prevent path traversal outside uiDir
    const relFromUi = path.relative(uiDir, filePath);
    if (relFromUi.startsWith('..') || path.isAbsolute(relFromUi)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(uiDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  });

  const openSockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  // Attach WebSocket server for PTY
  const wss = new WebSocketServer({ noServer: true });
  ptyManager.setupPtyWebSocket(wss, {
    cwd,
    onPtyExit: (commandId, exitCode) => {
      broadcastSse('pty-exit', { commandId, exitCode });
    },
  });

  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        if (originUrl.hostname !== '127.0.0.1' && originUrl.hostname !== 'localhost') {
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }
    const pathname = new URL(request.url || '/', `http://127.0.0.1:${actualPort}`).pathname;
    if (pathname === '/pty') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen({ host: '127.0.0.1', port: actualPort }, () => {
      resolve();
    });
  });

  const url = `http://127.0.0.1:${actualPort}`;
  log.ok(`Local Build UI running at ${url}`);

  return {
    server,
    port: actualPort,
    url,
    close: async () => {
      // 1. Close all active SSE response streams
      for (const resStream of sseClients) {
        try {
          resStream.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();

      // 2. Kill active PTY processes
      ptyManager.close();

      // 3. Terminate WebSocket clients
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // ignore
        }
      }
      try {
        wss.close();
      } catch {
        // ignore
      }

      // 4. Destroy all open TCP sockets
      for (const socket of openSockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      openSockets.clear();

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!data.trim()) resolve({});
      try {
        const parsed = JSON.parse(data);
        if (typeof parsed !== 'object' || parsed === null) {
          resolve({});
        } else {
          resolve(parsed);
        }
      } catch (err: any) {
        reject(new Error(`Invalid JSON body: ${err?.message || err}`));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

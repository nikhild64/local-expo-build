import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import Busboy from 'busboy';
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
import { readExpoConfig } from '../core/expoConfig';
import { EasApiError, EasAuth, resolveEasAuth } from '../core/eas/api';
import { EAS_PROJECT_NAME, createProject, getEasViewer, listProjects, writeProjectIdToAppJson } from '../core/eas/link';
import { configureEasProject } from '../core/eas/configure';
import { fetchEasKeystore, listEasKeystores, uploadLocalKeystoreToEas } from '../core/keystore/easApiFetch';
import { compareScripts, readPackageScripts, scaffoldProject } from '../core/scaffoldScripts';

export interface UiServerOpts {
  cwd: string;
  port?: number;
  dryRun?: boolean;
  openBrowser?: boolean;
  logs?: boolean;
  /** Suppress the startup banner (used by tests: console output interleaving
   *  with node:test's stdout protocol on Windows corrupts the runner stream). */
  quiet?: boolean;
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
  const terminalLogs = !!opts.logs;
  const quiet = !!opts.quiet;

  let activeBuild: { status: 'building'; startedAt: string } | null = null;
  let buildAbort: AbortController | null = null;
  let activeEasOperation = false;
  let pastedEasAuth: EasAuth | null = null;
  const sseClients: Set<ServerResponse> = new Set();

  const currentEasAuth = (): EasAuth | null => pastedEasAuth || resolveEasAuth();
  /** Strip plaintext keystore passwords before sending props to the browser. */
  const redactKeystoreProps = (props: any): any => {
    if (!props) return props;
    const { storePassword, keyPassword, ...safe } = props;
    return safe;
  };
  const redactLogLine = (message: string): string =>
    message
      .replace(/(authorization|expo-session|token|password|keyPassword|storePassword)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
      .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, '[REDACTED_BASE64]');
  const serverLog = (message: string) => {
    if (terminalLogs) log.info(`[ui] ${redactLogLine(message)}`);
  };
  const withEasOperation = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    if (activeEasOperation) {
      const err: any = new Error('Another EAS operation is already in progress.');
      err.status = 409;
      throw err;
    }
    activeEasOperation = true;
    try { return await operation(); } finally { activeEasOperation = false; }
  };

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
          let projectName = path.basename(cwd);
          const pkgPath = path.join(cwd, 'package.json');
          if (fs.existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
              if (typeof pkg.name === 'string' && pkg.name.trim()) {
                projectName = pkg.name.trim();
              }
            } catch {
              /* ignore malformed package.json */
            }
          }
          res.writeHead(200);
          res.end(
            JSON.stringify({
              cwd,
              projectName,
              folderName: path.basename(cwd),
              port: actualPort,
              dryRun,
              buildStatus: activeBuild ? 'building' : 'idle',
              easReady: isEasReady(easLink),
              easLink,
              keystoreProps: redactKeystoreProps(readKeystoreProps(cwd)),
            })
          );
          return;
        }

        if (req.method === 'GET' && pathname === '/api/doctor') {
          serverLog('Running Doctor checks');
          const summary = await collectDoctorChecks(cwd);
          res.writeHead(200);
          res.end(JSON.stringify(summary));
          return;
        }

        if (req.method === 'GET' && pathname === '/api/eas/auth') {
          const auth = currentEasAuth();
          if (!auth) {
            res.writeHead(200);
            res.end(JSON.stringify({ authenticated: false, source: 'none' }));
            return;
          }
          try {
            const viewer = await getEasViewer(auth);
            res.writeHead(200);
            res.end(JSON.stringify({ authenticated: true, username: viewer.username, accounts: viewer.accounts, source: 'token' in auth ? 'token' : 'session' }));
          } catch (err) {
            if (err instanceof EasApiError && err.isAuthError) pastedEasAuth = null;
            throw err;
          }
          return;
        }

        if (req.method === 'POST' && pathname === '/api/eas/auth') {
          const body = await parseJsonBody(req);
          if (typeof body.token !== 'string' || !body.token.trim()) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'token is required' })); return;
          }
          const auth: EasAuth = { token: body.token.trim() };
          const viewer = await getEasViewer(auth);
          pastedEasAuth = auth;
          res.writeHead(200);
          res.end(JSON.stringify({ authenticated: true, username: viewer.username, accounts: viewer.accounts, source: 'token' }));
          return;
        }

        if (req.method === 'GET' && pathname === '/api/eas/projects') {
          const account = parsedUrl.searchParams.get('account');
          if (!account) { res.writeHead(400); res.end(JSON.stringify({ error: 'account is required' })); return; }
          const projects = await listProjects(account, currentEasAuth());
          res.writeHead(200); res.end(JSON.stringify({ projects })); return;
        }

        if (req.method === 'POST' && pathname === '/api/eas/link') {
          serverLog('Linking EAS project');
          const body = await parseJsonBody(req);
          if (typeof body.projectId !== 'string' && !(typeof body.accountId === 'string' && typeof body.projectName === 'string')) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'projectId or accountId and projectName are required' })); return;
          }
          const link = detectEasLink(cwd);
          const config = readExpoConfig(cwd);
          if (link.kind === 'dynamic-unreadable' || config?.source === 'dynamic') {
            const projectId = typeof body.projectId === 'string' ? body.projectId : '<EAS_PROJECT_ID>';
            res.writeHead(409);
            res.end(JSON.stringify({ error: `Your project uses app.config.js, so app.json cannot be updated safely. Add this to your config: extra: { ...config.extra, eas: { ...config.extra?.eas, projectId: '${projectId}' } }` }));
            return;
          }
          const result = await withEasOperation(async () => {
            let projectId = body.projectId;
            if (!projectId) {
              if (!EAS_PROJECT_NAME.test(body.projectName)) throw new Error('Project name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.');
              projectId = (await createProject(body.accountId, body.projectName, currentEasAuth())).id;
            }
            writeProjectIdToAppJson(cwd, projectId, body.overwrite === true);
            return { projectId };
          });
          broadcastSse('doctor-updated', {});
          serverLog(`EAS project linked (${result.projectId})`);
          res.writeHead(200); res.end(JSON.stringify({ success: true, ...result })); return;
        }

        if (req.method === 'POST' && pathname === '/api/eas/configure') {
          serverLog('Running eas build:configure --platform android');
          const result = await withEasOperation(() => configureEasProject(cwd));
          broadcastSse('doctor-updated', {});
          serverLog(result.created ? 'EAS CLI created eas.json' : 'eas.json already exists; skipped EAS CLI');
          res.writeHead(200); res.end(JSON.stringify(result)); return;
        }

        if (req.method === 'GET' && pathname === '/api/eas/keystores') {
          const link = detectEasLink(cwd);
          if (link.kind !== 'linked') { res.writeHead(409); res.end(JSON.stringify({ error: 'This project is not linked to EAS. Link an EAS project first.' })); return; }
          const keystores = await listEasKeystores(link.projectId, currentEasAuth());
          res.writeHead(200); res.end(JSON.stringify({ projectId: link.projectId, keystores })); return;
        }

        if (req.method === 'POST' && pathname === '/api/keystore/fetch-eas') {
          serverLog('Fetching Android keystore metadata from EAS');
          if (activeBuild) { res.writeHead(409); res.end(JSON.stringify({ error: 'Cannot replace a keystore while a build is running.' })); return; }
          const link = detectEasLink(cwd);
          if (link.kind !== 'linked') { res.writeHead(409); res.end(JSON.stringify({ error: 'This project is not linked to EAS. Link an EAS project first.' })); return; }
          const body = await parseJsonBody(req);
          const result = await withEasOperation(() => fetchEasKeystore(cwd, link.projectId, body.buildCredentialsId, body.overwrite === true, currentEasAuth()));
          broadcastSse('keystore-updated', {});
          serverLog(`Fetched EAS keystore (${result.storeFile}, alias=${result.keyAlias})`);
          res.writeHead(200); res.end(JSON.stringify({ success: true, ...result })); return;
        }

        if (req.method === 'POST' && pathname === '/api/eas/keystores/upload') {
          serverLog('Uploading local Android keystore to EAS');
          const link = detectEasLink(cwd);
          if (link.kind !== 'linked') { res.writeHead(409); res.end(JSON.stringify({ error: 'This project is not linked to EAS. Link an EAS project first.' })); return; }
          const result = await withEasOperation(() => uploadLocalKeystoreToEas(cwd, link.projectId, currentEasAuth()));
          broadcastSse('keystore-updated', {});
          serverLog(`Uploaded local keystore to EAS (${result.name})`);
          res.writeHead(200); res.end(JSON.stringify({ success: true, ...result })); return;
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
          if (activeBuild) {
            res.writeHead(409);
            res.end(JSON.stringify({ error: 'Cannot rehydrate the keystore while a build is running.' }));
            return;
          }
          await rehydrateKeystore(cwd);
          broadcastSse('keystore-updated', {});
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
          return;
        }

        if (req.method === 'GET' && pathname === '/api/scaffold/status') {
          const scripts = compareScripts(cwd);
          const pkgScripts = readPackageScripts(cwd);
          res.writeHead(200);
          res.end(
            JSON.stringify({
              hasScripts: scripts.some((s) => s.exists),
              scripts,
              pkgScripts,
            })
          );
          return;
        }

        if (req.method === 'POST' && pathname === '/api/scaffold') {
          const body = await parseJsonBody(req);
          const result = await withEasOperation(() => scaffoldProject(cwd, body.force === true));
          broadcastSse('doctor-updated', {});
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, ...result }));
          return;
        }

        if (req.method === 'GET' && pathname === '/api/keystore/status') {
          const props = readKeystoreProps(cwd);
          const candidate = findRehydrateCandidate(cwd);
          res.writeHead(200);
          res.end(
            JSON.stringify({
              configured: !!props,
              props: redactKeystoreProps(props),
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
          if (activeBuild) {
            res.writeHead(409);
            res.end(JSON.stringify({ error: 'Cannot modify the keystore while a build is running.' }));
            return;
          }
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
          if (activeBuild) {
            res.writeHead(409);
            res.end(JSON.stringify({ error: 'Cannot replace the keystore while a build is running.' }));
            return;
          }
          const bb = Busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024 } });
          let tmpPath = '';
          let originalFilename = '';
          let keyAlias = '';
          let storePassword = '';
          let keyPassword = '';
          let uploadError: string | null = null;
          let wsStream: fs.WriteStream | null = null;

          bb.on('file', (fieldname, file, info) => {
            const { filename } = info;
            originalFilename = path.basename(filename);
            const ext = path.extname(filename).toLowerCase();
            if (ext !== '.jks' && ext !== '.keystore' && ext !== '.p12') {
              uploadError = 'Invalid file extension. Only .jks, .keystore, and .p12 files are accepted.';
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
            // A busboy error (e.g. file over the size limit) aborts the request
            // stream, so 'finish' may never fire — respond here instead of
            // leaving the client hanging.
            if (!res.headersSent) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: uploadError }));
            }
          });

          bb.on('finish', async () => {
            if (res.headersSent) return;
            // busboy's 'finish' can fire while the piped file stream is still
            // buffered to disk; wait for it to close before checking the file.
            if (wsStream) {
              const ws = wsStream;
              await new Promise<void>((resolve) => {
                if (ws.closed) return resolve();
                ws.once('close', () => resolve());
                ws.once('error', () => resolve());
              });
            }
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
                // Register under the original filename (not the temp upload
                // path) so keystore.properties and credentials.json keep a
                // stable, recognizable storeFile across re-uploads.
                storeFile: originalFilename,
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
          const body = await parseJsonBody(req);
          const buildDebug = body.debug === true;
          if (!buildDebug && !ksProps) {
            res.writeHead(409);
            res.end(
              JSON.stringify({
                error:
                  'Signing keystore not configured (keystore.properties missing or incomplete). Please set up your keystore in the Keystore tab before building.',
              })
            );
            return;
          }

          activeBuild = { status: 'building', startedAt: new Date().toISOString() };
          buildAbort = new AbortController();
          serverLog(`Starting Android ${buildDebug ? 'debug APK' : body.aab ? 'AAB' : 'APK'} build`);
          broadcastSse('build-start', { kind: buildDebug ? 'APK' : body.aab ? 'AAB' : 'APK' });

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
                debug: buildDebug,
                maxRam: body.maxRam,
                signal: buildAbort.signal,
                ensureKeystoreMode: 'required-existing',
                onLine: (line) => {
                  broadcastSse('log', { line });
                  serverLog(line);
                },
                logger: {
                  step: (msg) => { broadcastSse('step', { message: msg }); serverLog(`STEP: ${msg}`); },
                  ok: (msg) => { broadcastSse('log', { line: `[OK] ${msg}` }); serverLog(`OK: ${msg}`); },
                  info: (msg) => { broadcastSse('log', { line: `[INFO] ${msg}` }); serverLog(`INFO: ${msg}`); },
                  warn: (msg) => { broadcastSse('log', { line: `[WARN] ${msg}` }); serverLog(`WARN: ${msg}`); },
                  dim: (msg) => { broadcastSse('log', { line: `[DIM] ${msg}` }); serverLog(msg); },
                  error: (msg) => { broadcastSse('log', { line: `[ERR] ${msg}` }); serverLog(`ERROR: ${msg}`); },
                },
              });
              broadcastSse('build-complete', { success: true, artifact: result.artifact, kind: result.kind });
              serverLog(`Build complete: ${result.artifact}`);
            } catch (err: any) {
              const aborted = buildAbort?.signal?.aborted === true || err?.name === 'AbortError';
              const errorMsg = aborted ? 'Build stopped by user.' : (err?.message || String(err));
              broadcastSse('build-complete', { success: false, error: errorMsg });
              serverLog(aborted ? 'Build stopped by user.' : `Build failed: ${err?.message || String(err)}`);
            } finally {
              activeBuild = null;
              buildAbort = null;
            }
          })();

          return;
        }

        if (req.method === 'POST' && pathname === '/api/build/stop') {
          if (!activeBuild || !buildAbort) {
            res.writeHead(409);
            res.end(JSON.stringify({ error: 'No build is currently running.' }));
            return;
          }
          buildAbort.abort();
          serverLog('Stop requested by user.');
          res.writeHead(202);
          res.end(JSON.stringify({ status: 'stopping' }));
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: `API route not found: ${pathname}` }));
      } catch (err: any) {
        const status = err instanceof EasApiError && err.isAuthError ? 401 : err?.status || 500;
        serverLog(`${req.method} ${pathname} failed (${status}): ${err?.message || String(err)}`);
        res.writeHead(status);
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

  await new Promise<void>((resolve) => {
    server.listen({ host: '127.0.0.1', port: actualPort }, () => {
      resolve();
    });
  });

  const url = `http://127.0.0.1:${actualPort}`;
  if (!quiet) {
    log.ok(`Local Build UI running at ${url}`);
  }

  return {
    server,
    port: actualPort,
    url,
    close: async () => {
      // 0. Stop any in-flight build so the child Gradle process is terminated
      //    cleanly instead of being killed abruptly by process.exit below.
      if (buildAbort) {
        try {
          buildAbort.abort();
        } catch {
          // ignore
        }
      }

      // 1. Close all active SSE response streams
      for (const resStream of sseClients) {
        try {
          resStream.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();

      // 2. Destroy all open TCP sockets
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
      if (!data.trim()) {
        resolve({});
        return;
      }
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

import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';

export type EasAuth = { sessionSecret: string } | { token: string };

export class EasApiError extends Error {
  code?: string;
  status?: number;
  isAuthError: boolean;

  constructor(message: string, opts: { code?: string; status?: number; isAuthError?: boolean } = {}) {
    super(message);
    this.name = 'EasApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.isAuthError = !!opts.isAuthError;
  }
}

export function resolveEasAuth(): EasAuth | null {
  if (process.env.EXPO_TOKEN) return { token: process.env.EXPO_TOKEN };
  const statePath = path.join(os.homedir(), '.expo', 'state.json');
  try {
    const secret = JSON.parse(fs.readFileSync(statePath, 'utf8'))?.auth?.sessionSecret;
    return typeof secret === 'string' && secret ? { sessionSecret: secret } : null;
  } catch {
    return null;
  }
}

export async function easGraphql<T>(
  query: string,
  variables: object = {},
  auth: EasAuth | null = resolveEasAuth()
): Promise<T> {
  if (!auth) {
    throw new EasApiError('EAS authentication is required. Set EXPO_TOKEN, run eas login, or paste an access token.', {
      isAuthError: true,
    });
  }
  const body = JSON.stringify({ query, variables });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    'expo-client-info': JSON.stringify({ appVersion: '0.0.0', sdkVersion: '0.0.0' }),
  };
  if ('token' in auth) headers.authorization = `Bearer ${auth.token}`;
  else headers['expo-session'] = auth.sessionSecret;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fail = (error: EasApiError) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const req = https.request({ hostname: 'api.expo.dev', path: '/graphql', method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) {
          req.destroy();
          fail(new EasApiError('EAS API response was too large.', { status: res.statusCode }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        const status = res.statusCode;
        let json: any;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          fail(new EasApiError('EAS API returned an invalid response.', { status, isAuthError: status === 401 || status === 403 }));
          return;
        }
        const firstError = Array.isArray(json.errors) ? json.errors[0] : undefined;
        if (firstError || !status || status >= 400) {
          fail(new EasApiError(firstError?.message || `EAS API request failed (${status || 'unknown status'}).`, {
            code: firstError?.extensions?.errorCode,
            status,
            isAuthError: status === 401 || status === 403 || firstError?.extensions?.errorCode === 'UNAUTHENTICATED',
          }));
          return;
        }
        settled = true;
        resolve(json.data as T);
      });
    });
    req.setTimeout(20_000, () => {
      req.destroy();
      fail(new EasApiError('EAS API request timed out.'));
    });
    req.on('error', (err) => fail(new EasApiError(`EAS API request failed: ${err.message}`)));
    req.write(body);
    req.end();
  });
}
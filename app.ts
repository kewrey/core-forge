// The forge's HTTP server: one process answering the git smart-HTTP surface,
// the REST v3 API, the GraphQL endpoint and the MCP endpoint over one shared
// store. Every route but the env's /healthz boot probe requires the bearer
// token the harness hands the process (MAKEFUN_SHOP_TOKEN); every reply is
// JSON (or a git protocol stream) and carries an X-GitHub-Request-Id.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Forge } from './store.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
    'X-GitHub-Request-Id': randomUUID(),
    ...headers,
  });
  res.end(payload);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': randomUUID(),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length);
    if (expectedToken === '') return presented.length > 0;
    return presented === expectedToken;
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge.invalid');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/<endpoint>
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const name = decodeURIComponent(gitMatch[2] as string);
          const endpoint = gitMatch[3] as string;
          const repo = forge.getRepo(owner, name);
          const protocolHeader = req.headers['git-protocol'];
          const protocolVersion = typeof protocolHeader === 'string' && protocolHeader.includes('version=2') ? 2 : 0;
          if (endpoint === 'info/refs' && method === 'GET') {
            const result = infoRefs(forge, repo, url.searchParams.get('service') ?? '', protocolVersion);
            if (result.contentType === 'application/json') sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
            else sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const result = uploadPack(forge, repo, body, protocolVersion);
            if (result.contentType === 'application/json') sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
            else sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const result = receivePack(forge, repo, body);
            if (result.contentType === 'application/json') sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
            else sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON body' });
            return;
          }
          const result = await handleGraphQL(forge, parsed);
          sendJson(res, 200, result);
          return;
        }

        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: null });
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(forge, raw.toString('utf8'));
          if (result === null) {
            res.writeHead(202, { 'X-GitHub-Request-Id': randomUUID() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => decodeURIComponent(segment));
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Malformed JSON body' });
                return;
              }
            }
          }
          const origin = `http://${req.headers.host ?? 'localhost'}`;
          const result = handleRest(forge, method, segments, url.searchParams, body, origin);
          if (result.status === 204 || result.body === undefined) {
            res.writeHead(result.status, { 'X-GitHub-Request-Id': randomUUID(), ...(result.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, result.headers);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // One bad request must never take the server down (repo-survives-errors).
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

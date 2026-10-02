// Minimal JSON-over-HTTP server router and traced client (node:http + fetch, no dependencies).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface Response {
  status?: number;
  body?: unknown;
  raw?: string | Buffer;
  contentType?: string;
}

export type Handler = (req: Request) => Response | Promise<Response>;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const route = this.match(req.method ?? 'GET', url.pathname);
      if (!route) throw new HttpError(404, 'not_found', `no route for ${req.method} ${url.pathname}`);
      const body = await readJson(req);
      const params: Record<string, string> = {};
      const m = route.re.exec(url.pathname);
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m?.[i + 1] ?? '')));
      const out = await route.handler({
        method: req.method ?? 'GET',
        path: url.pathname,
        params,
        query: url.searchParams,
        headers: req.headers,
        body,
      });
      if (out.raw !== undefined) {
        res.writeHead(out.status ?? 200, { 'content-type': out.contentType ?? 'text/plain; charset=utf-8' });
        res.end(out.raw);
        return;
      }
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out.body ?? {}));
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, 'internal', (err as Error).message);
      res.writeHead(e.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } }));
    }
  }

  match(method: string, path: string): Route | undefined {
    return this.routes.find((r) => r.method === method && r.re.test(path));
  }
}

const MAX_BODY_BYTES = 256 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'bad_request', 'body must be a JSON object');
}

export interface Listening {
  url: string;
  close(): Promise<void>;
}

export function listen(router: Router, port = 0, host = '127.0.0.1'): Promise<Listening> {
  const server = createServer((req, res) => void router.dispatch(req, res));
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${addr.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

export const json = (body: unknown, status = 200): Response => ({ status, body });

/** Reads a required string field from a JSON body, or throws 400. */
export function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0) throw new HttpError(400, 'bad_request', `missing string field "${key}"`);
  return v;
}

export function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function obj(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = body[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_request', `missing object field "${key}"`);
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------- client

export interface NetTrace {
  from: string;
  to: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  request?: unknown;
  response?: unknown;
}

export class ApiError extends Error {
  status: number;
  code: string;
  body: unknown;
  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface RequestOptions {
  to: string;
  method: string;
  url: string;
  body?: unknown;
  token?: string;
}

export interface HttpClient {
  request<T>(opts: RequestOptions): Promise<T>;
}

export function createClient(from: string, onTrace?: (t: NetTrace) => void): HttpClient {
  return {
    async request<T>(opts: RequestOptions): Promise<T> {
      const started = performance.now();
      const headers: Record<string, string> = { accept: 'application/json' };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const res = await fetch(opts.url, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      let parsed: unknown = undefined;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
      onTrace?.({
        from,
        to: opts.to,
        method: opts.method,
        path: new URL(opts.url).pathname,
        status: res.status,
        ms: performance.now() - started,
        request: opts.body,
        response: parsed,
      });
      if (!res.ok) {
        const err = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`, parsed);
      }
      return parsed as T;
    },
  };
}

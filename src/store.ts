// The file store: a prefix inside a Vercel Blob store. Every file version is uploaded once at an
// immutable content-addressed path (`<prefix>_/<sha256>`), and one small manifest.json maps paths
// to those URLs. Only the manifest is ever overwritten, so the CDN's minute of caching can delay a
// change but never mismatch a manifest with the file it names. A few well-known paths (app.js,
// eink-host) are also written at their plain path for hosts that fetch by name.
import { createHash } from 'node:crypto';
import { del, list, put } from '@vercel/blob';

export interface Entry { sha256: string; size: number; url: string; content_type: string; updated: string }
export interface Manifest { version: 1; generated: string; base: string; files: Record<string, Entry> }

const MANIFEST = 'manifest.json';
const LEGACY_PATHS = new Set((process.env.EINK_LEGACY_PATHS ?? 'app.js,eink-host').split(',').map((s) => s.trim()).filter(Boolean));
const YEAR = 365 * 24 * 3600;

export class Store {
  /** The manifest as this process last wrote or read it: the CDN may lag for a minute. */
  private cached: Manifest | null = null;

  constructor(private readonly prefix: string, private readonly token: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Store {
    const token = env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
    let prefix = env.EINK_PREFIX ?? 'eink/';
    if (!prefix.endsWith('/')) prefix += '/';
    return new Store(prefix.replace(/^\/+/, ''), token);
  }

  /** Paths are relative, forward-slash, no traversal: they map straight onto the device's app directory. */
  static checkPath(path: string): string {
    const p = path.replace(/^\/+/, '');
    if (!p || p === MANIFEST || p.split('/').some((s) => s === '' || s === '.' || s === '..') || /[\x00-\x1f]/.test(p)) {
      throw new Error(`invalid path: ${JSON.stringify(path)}`);
    }
    return p;
  }

  private async upload(path: string, body: Buffer | string, contentType: string, immutable = false) {
    return put(this.prefix + path, body, {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType, cacheControlMaxAge: immutable ? YEAR : 60, token: this.token,
    });
  }

  private blobPath(sha256: string): string {
    return `_/${sha256}`;
  }

  async manifest(): Promise<Manifest> {
    if (this.cached) return structuredClone(this.cached);
    const { blobs } = await list({ prefix: this.prefix + MANIFEST, token: this.token, limit: 1 });
    const blob = blobs.find((b) => b.pathname === this.prefix + MANIFEST);
    if (!blob) return { version: 1, generated: new Date(0).toISOString(), base: '', files: {} };
    // a query string keeps the CDN from answering with a copy up to a minute old
    const res = await fetch(`${blob.url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
    this.cached = (await res.json()) as Manifest;
    return structuredClone(this.cached);
  }

  private async writeManifest(m: Manifest): Promise<Manifest> {
    m.generated = new Date().toISOString();
    const hadBase = m.base !== '';
    const r = await this.upload(MANIFEST, JSON.stringify(m, null, 1), 'application/json');
    m.base = r.url.slice(0, r.url.length - MANIFEST.length);
    // the store's public host is only known after the first upload: write it back once
    if (!hadBase) await this.upload(MANIFEST, JSON.stringify(m, null, 1), 'application/json');
    this.cached = structuredClone(m);
    return m;
  }

  async put(path: string, body: Buffer, contentType: string): Promise<Entry> {
    path = Store.checkPath(path);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const m = await this.manifest();
    // the same bytes may already be stored under another path (or this one): reuse the blob
    const existing = Object.values(m.files).find((e) => e.sha256 === sha256);
    const url = existing?.url ?? (await this.upload(this.blobPath(sha256), body, contentType, true)).url;
    if (LEGACY_PATHS.has(path)) await this.upload(path, body, contentType);
    const entry: Entry = { sha256, size: body.length, url, content_type: contentType, updated: new Date().toISOString() };
    const previous = m.files[path];
    m.files[path] = entry;
    await this.writeManifest(m);
    if (previous && previous.sha256 !== sha256 && !Object.values(m.files).some((e) => e.url === previous.url)) {
      await del(previous.url, { token: this.token });
    }
    return entry;
  }

  async delete(path: string): Promise<boolean> {
    path = Store.checkPath(path);
    const m = await this.manifest();
    const entry = m.files[path];
    if (!entry) return false;
    delete m.files[path];
    if (!Object.values(m.files).some((e) => e.url === entry.url)) await del(entry.url, { token: this.token });
    if (LEGACY_PATHS.has(path)) {
      const { blobs } = await list({ prefix: this.prefix + path, token: this.token, limit: 1 });
      const plain = blobs.find((b) => b.pathname === this.prefix + path);
      if (plain) await del(plain.url, { token: this.token });
    }
    await this.writeManifest(m);
    return true;
  }

  async get(path: string): Promise<{ entry: Entry; body: Buffer }> {
    path = Store.checkPath(path);
    const m = await this.manifest();
    const entry = m.files[path];
    if (!entry) throw new Error(`no such file: ${path}`);
    const res = await fetch(entry.url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    return { entry, body: Buffer.from(await res.arrayBuffer()) };
  }
}

export function guessType(path: string, fallback = 'application/octet-stream'): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ({
    js: 'application/javascript', mjs: 'application/javascript', json: 'application/json',
    txt: 'text/plain', md: 'text/markdown', html: 'text/html', css: 'text/css', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', sh: 'text/x-shellscript', conf: 'text/plain',
  } as Record<string, string>)[ext] ?? fallback;
}

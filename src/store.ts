// The file store: a prefix inside a Vercel Blob store, plus a manifest.json next to the files
// that lists every path with its hash. Devices poll the manifest and download what changed.
import { createHash } from 'node:crypto';
import { del, list, put } from '@vercel/blob';

export interface Entry { sha256: string; size: number; url: string; content_type: string; updated: string }
export interface Manifest { version: 1; generated: string; base: string; files: Record<string, Entry> }

const MANIFEST = 'manifest.json';

export class Store {
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

  private async upload(path: string, body: Buffer | string, contentType: string) {
    return put(this.prefix + path, body, {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType, cacheControlMaxAge: 60, token: this.token,
    });
  }

  async manifest(): Promise<Manifest> {
    const { blobs } = await list({ prefix: this.prefix + MANIFEST, token: this.token, limit: 1 });
    const blob = blobs.find((b) => b.pathname === this.prefix + MANIFEST);
    if (!blob) return { version: 1, generated: new Date(0).toISOString(), base: '', files: {} };
    const res = await fetch(blob.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
    return (await res.json()) as Manifest;
  }

  private async writeManifest(m: Manifest): Promise<Manifest> {
    m.generated = new Date().toISOString();
    const hadBase = m.base !== '';
    const r = await this.upload(MANIFEST, JSON.stringify(m, null, 1), 'application/json');
    m.base = r.url.slice(0, r.url.length - MANIFEST.length);
    // the store's public host is only known after the first upload: write it back once
    if (!hadBase) await this.upload(MANIFEST, JSON.stringify(m, null, 1), 'application/json');
    return m;
  }

  async put(path: string, body: Buffer, contentType: string): Promise<Entry> {
    path = Store.checkPath(path);
    const r = await this.upload(path, body, contentType);
    const entry: Entry = {
      sha256: createHash('sha256').update(body).digest('hex'), size: body.length, url: r.url,
      content_type: contentType, updated: new Date().toISOString(),
    };
    const m = await this.manifest();
    m.files[path] = entry;
    await this.writeManifest(m);
    return entry;
  }

  async delete(path: string): Promise<boolean> {
    path = Store.checkPath(path);
    const m = await this.manifest();
    const entry = m.files[path];
    if (!entry) return false;
    await del(entry.url, { token: this.token });
    delete m.files[path];
    await this.writeManifest(m);
    return true;
  }

  async get(path: string): Promise<{ entry: Entry; body: Buffer }> {
    path = Store.checkPath(path);
    const m = await this.manifest();
    const entry = m.files[path];
    if (!entry) throw new Error(`no such file: ${path}`);
    const res = await fetch(entry.url, { cache: 'no-store' });
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

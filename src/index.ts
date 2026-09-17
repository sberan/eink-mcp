#!/usr/bin/env node
// eink-mcp: a stdio MCP server that hosts files for e-ink devices. Agents put files here; a device
// points its update URL at `base` and syncs manifest.json on every wake. See README.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store, guessType } from './store.js';

const MAX_INLINE = 512 * 1024;

const store = Store.fromEnv();
const server = new McpServer({ name: 'eink-mcp', version: '0.1.0' });

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

server.registerTool('status', {
  title: 'Store status',
  description: 'The public base URL devices sync from (set it as update_url on the device), the manifest, and the file count.',
  inputSchema: {},
}, async () => {
  const m = await store.manifest();
  return json({ base: m.base, manifest: m.base ? m.base + 'manifest.json' : '', files: Object.keys(m.files).length, generated: m.generated });
});

server.registerTool('list_files', {
  title: 'List files',
  description: 'Every file in the store with its size, sha256, public URL and last update.',
  inputSchema: {},
}, async () => json((await store.manifest()).files));

server.registerTool('put_file', {
  title: 'Put a file',
  description: 'Upload a file by path (relative, as it will appear in the device app directory). Give text as `content` or binary as `content_base64`. Devices pick it up on their next sync.',
  inputSchema: {
    path: z.string().describe('relative path, e.g. app.js or data/2026-09-16.json'),
    content: z.string().optional().describe('UTF-8 text content'),
    content_base64: z.string().optional().describe('binary content, base64'),
    content_type: z.string().optional().describe('MIME type; guessed from the extension when omitted'),
  },
}, async ({ path, content, content_base64, content_type }) => {
  if ((content === undefined) === (content_base64 === undefined)) throw new Error('give exactly one of content or content_base64');
  const body = content !== undefined ? Buffer.from(content, 'utf8') : Buffer.from(content_base64!, 'base64');
  return json({ path, ...(await store.put(path, body, content_type ?? guessType(path))) });
});

server.registerTool('put_file_from_url', {
  title: 'Put a file from a URL',
  description: 'Download a URL and store it under `path`, so large binaries (a host build from CI, for example) never pass through the conversation.',
  inputSchema: {
    path: z.string(),
    url: z.string().url(),
    content_type: z.string().optional(),
  },
}, async ({ path, url, content_type }) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const type = content_type ?? res.headers.get('content-type')?.split(';')[0] ?? guessType(path);
  return json({ path, ...(await store.put(path, body, type)) });
});

server.registerTool('get_file', {
  title: 'Get a file',
  description: 'Read a file back: text for text types, base64 otherwise. Large files are truncated; use the URL from list_files for the whole thing.',
  inputSchema: { path: z.string() },
}, async ({ path }) => {
  const { entry, body } = await store.get(path);
  const isText = /^(text\/|application\/(javascript|json|xml))/.test(entry.content_type);
  const slice = body.subarray(0, MAX_INLINE);
  return json({
    path, ...entry, truncated: body.length > MAX_INLINE,
    ...(isText ? { content: slice.toString('utf8') } : { content_base64: slice.toString('base64') }),
  });
});

server.registerTool('delete_file', {
  title: 'Delete a file',
  description: 'Remove a file from the store and the manifest. Devices delete their copy on the next sync.',
  inputSchema: { path: z.string() },
}, async ({ path }) => json({ path, deleted: await store.delete(path) }));

await server.connect(new StdioServerTransport());

#!/usr/bin/env node
// Upload local files through the server: scripts/put.mjs <path>=<file> ...   (EINK_PREFIX, BLOB_READ_WRITE_TOKEN from the environment)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const client = new Client({ name: 'put', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [server], env: { ...process.env } }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};
for (const arg of process.argv.slice(2)) {
  const [path, file] = arg.split('=');
  const body = readFileSync(file ?? path);
  const isText = /\.(js|mjs|json|txt|md|html|css|svg|sh|conf)$/.test(path);
  const r = await call('put_file', isText ? { path, content: body.toString('utf8') } : { path, content_base64: body.toString('base64') });
  console.log(`${path}: ${r.size} bytes, sha256 ${r.sha256.slice(0, 12)}`);
}
console.log(JSON.stringify(await call('status')));
await client.close();

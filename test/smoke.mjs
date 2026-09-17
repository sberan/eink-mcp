// End-to-end against the real Blob store: needs BLOB_READ_WRITE_TOKEN in the environment.
// Uses its own prefix so it never touches device files.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({
  command: 'node', args: ['dist/index.js'],
  env: { ...process.env, EINK_PREFIX: 'eink-smoke/' },
}));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log('tools:', tools.join(' '));
const stamp = new Date().toISOString();
const put = await call('put_file', { path: 'hello.txt', content: `hello ${stamp}\n` });
console.log('put:', put.size, 'bytes', put.url);
const status = await call('status');
console.log('status:', status);
// the CDN may serve the previous manifest for up to a minute; a device simply syncs again later
let manifest;
for (let i = 0; i < 20; i++) {
  manifest = await (await fetch(status.manifest, { cache: 'no-store' })).json();
  if (manifest.files['hello.txt']?.sha256 === put.sha256) break;
  if (i === 0) console.log('waiting for the CDN to pick up the manifest...');
  await new Promise((r) => setTimeout(r, 5000));
}
if (manifest.files['hello.txt']?.sha256 !== put.sha256) throw new Error('manifest does not list the file');
if (!manifest.files['hello.txt'].url.includes('/_/' + put.sha256)) throw new Error('manifest should point at the immutable blob');
const got = await call('get_file', { path: 'hello.txt' });
if (got.content !== `hello ${stamp}\n`) throw new Error('get_file returned different content');
const bin = await call('put_file', { path: 'bin/blob.bin', content_base64: Buffer.from([0, 255, 1, 2]).toString('base64') });
const gotBin = await call('get_file', { path: 'bin/blob.bin' });
if (gotBin.content_base64 !== Buffer.from([0, 255, 1, 2]).toString('base64')) throw new Error('binary round trip failed');
console.log('list:', Object.keys(await call('list_files')));
for (const path of ['hello.txt', 'bin/blob.bin']) console.log('delete:', path, (await call('delete_file', { path })).deleted);
const after = await call('list_files');
if (Object.keys(after).length) throw new Error('files left after delete');
await client.close();
console.log('smoke OK');

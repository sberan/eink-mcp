# eink-mcp

An MCP server that hosts files for e-ink devices and syncs them down.

Agents put files here with MCP tools. Each file version lands once at an immutable,
content-addressed public URL in a Vercel Blob store, and a small `manifest.json` maps paths to
those URLs with their sha256. Only the manifest is ever overwritten, so a reader can never see a
manifest that disagrees with the file it names; it can only be up to a minute behind. A device such as a
jailbroken Kindle running [eink-ui](https://github.com/sberan/eink-ui) points its update URL at
that manifest and pulls whatever changed on every start, wake and reload. Nothing has to reach
the device: it is behind NAT and asleep most of the day, so it always pulls.

```
agent ──MCP──▶ eink-mcp ──put──▶ Vercel Blob (public URLs + manifest.json) ◀──pull── device
```

## Tools

| tool | effect |
|---|---|
| `status` | the public base URL to set as the device's update URL, the manifest URL, file count |
| `list_files` | every file with size, sha256, URL and last update |
| `put_file` | upload `content` (text) or `content_base64` (binary) at a relative path |
| `put_file_from_url` | download a URL into the store, for large builds coming out of CI |
| `get_file` | read a file back (text or base64, truncated past 512 KiB) |
| `delete_file` | remove a file; devices drop their copy on the next sync |

Paths are relative and map straight onto the device's app directory. On eink-ui devices `app.js`
is the React bundle and `eink-host` is the host binary; changing either restarts the host.

## Run it

Environment:

- `BLOB_READ_WRITE_TOKEN` (required): a Vercel Blob read-write token. This is the only
  credential; the store is the only state.
- `EINK_PREFIX` (default `eink/`): the folder inside the store, one per device or fleet.

```sh
npx eink-mcp                      # from npm, stdio
nix run github:sberan/eink-mcp    # from the flake, stdio
```

### Claude Code

```sh
claude mcp add eink -e BLOB_READ_WRITE_TOKEN=... -- npx eink-mcp
```

### pg_mcp (Nix runtime)

pg_mcp builds the flake at a pinned commit and runs it over stdio; the Blob token is supplied
as the server's bearer credential through `token_env`.

```sql
SELECT mcp.register_server('eink', auth => 'bearer',
  options => '{"token_env":"BLOB_READ_WRITE_TOKEN","env":{"EINK_PREFIX":"kindle/"}}'::jsonb,
  runtime => '{"kind":"nix","source":"github:sberan/eink-mcp","revision":"<commit>",
               "attribute":"mcp","executable":"bin/eink-mcp"}'::jsonb);
-- then set the bearer token (the Blob token) and wait for mcp.status('eink').runtime = ready
```

## Manifest

```json
{ "version": 1, "generated": "2026-09-17T01:59:51Z",
  "base": "https://<store>.public.blob.vercel-storage.com/kindle/",
  "files": { "app.js": { "sha256": "…", "size": 123304, "url": "…", "content_type": "application/javascript", "updated": "…" } } }
```

A device keeps the manifest's ETag and the sha256 of each file it holds, downloads only files
whose hash changed, verifies the hash (the CDN can lag a file behind its manifest for up to a
minute, in which case the device simply tries again on its next sync), and deletes files that
left the manifest.

## Develop

```sh
npm install && npm run build
BLOB_READ_WRITE_TOKEN=... npm run smoke   # end to end against a throwaway prefix
```

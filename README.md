# diskscout-mcp

[![CI](https://github.com/OWNER/diskscout-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/diskscout-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

**An MCP server that lets an AI assistant find out what is eating your disk space, and clean it up safely.**

Ask Claude "why is my C drive full?" and get real numbers: which folders are biggest, which single files are huge and untouched for a year, and which caches can be cleared without risk. Works with Claude Desktop, Claude Code and any other MCP client. Windows first, with macOS and Linux supported for scanning.

Site: https://OWNER.github.io/diskscout-mcp

## Why this exists

Disk analyzers like WinDirStat, WizTree and Folder Size are great when you are the one looking at the screen. They are not something an assistant can drive. `diskscout-mcp` gives the assistant the same core answers as structured tool calls, plus a small and heavily guarded set of cleanup actions, so you can say "help me free 50 GB" and stay in the loop for every decision.

## What it does

- **Scans** a folder or whole drive and keeps the result in memory, so follow up questions are instant.
- **Ranks** the biggest folders and files, with filters for file type, age and size.
- **Knows where junk lives:** temp folders, browser caches, package manager caches, crash dumps, and similar. Each has a risk level.
- **Cleans conservatively:** every change defaults to a dry run, protected locations are refused, and every real change is logged.

It currently exposes <!-- tool-count:start -->7<!-- tool-count:end --> tools, listed below.

## Example (illustrative)

> **You:** My C drive is almost full. Find out why and help me fix it.
>
> **Claude:** *(calls `list_drives`, `scan_folder`, `top_folders`, `cleanup_candidates`)*
> C: is 96% full with 18 GB free. The biggest folders are `Users\you\AppData` (84 GB), `Users\you\VirtualBox VMs` (61 GB) and `Users\you\.gradle` (22 GB). I also found 14.2 GB of caches that are safe to clear. Want me to start with the browser and npm caches?

## Quick start

You need [Node.js 22 or newer](https://nodejs.org).

```bash
git clone https://github.com/OWNER/diskscout-mcp.git
cd diskscout-mcp
npm install        # also builds the server
npm test           # optional, runs the test suite
```

Then register the server with your MCP client. Use the full path to `dist/src/index.js` from your clone.

**Claude Desktop.** Edit `claude_desktop_config.json` (on Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and restart the app:

```json
{
  "mcpServers": {
    "diskscout": {
      "command": "node",
      "args": ["C:\\path\\to\\diskscout-mcp\\dist\\src\\index.js"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add diskscout -- node C:\path\to\diskscout-mcp\dist\src\index.js
```

**Any other client:** run `node dist/src/index.js`. The server speaks MCP over stdio.

Then ask something like *"Scan my C drive and tell me what is using the most space."*

## Tools

<!-- tools:start -->
| Tool | What it does | Changes files |
|---|---|---|
| [`list_drives`](#list_drives) | List drives | No |
| [`scan_folder`](#scan_folder) | Scan a folder or drive | No |
| [`top_folders`](#top_folders) | Biggest folders | No |
| [`top_files`](#top_files) | Biggest files | No |
| [`cleanup_candidates`](#cleanup_candidates) | Known cleanup targets | No |
| [`clear_cleanup_target`](#clear_cleanup_target) | Clear a cleanup target | Yes, dry run by default |
| [`move_to_recycle_bin`](#move_to_recycle_bin) | Move to Recycle Bin | Yes, dry run by default |

### `list_drives`

Show every drive with total, used and free space. Start here to see which drive is filling up.

No parameters.

### `scan_folder`

Scan a folder or whole drive and remember the result so other tools answer instantly. Large drives can take a few minutes. The call waits up to wait_seconds, then reports progress. Call it again with the same path to keep waiting or to read the result. Read only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Folder or drive to scan, for example C:\ or C:\Users\me\AppData. Use ~ for the home folder. |
| `wait_seconds` | integer | `30` | How long to wait for the scan before returning progress. 0 starts the scan and returns immediately. |
| `rescan` | boolean | `false` | Ignore saved results and scan again. |

### `top_folders`

List the biggest folders inside a scanned path, largest first, with each folder's share of the total. Needs a finished scan that covers the path. Read only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Folder to look inside. Must be inside a scanned location. |
| `depth` | integer | `1` | How many levels down to include. 1 lists direct sub folders only. |
| `limit` | integer | `25` | Maximum rows to return. |
| `min_size_mb` | number | `0` | Hide folders smaller than this many MB. |

### `top_files`

List the largest files in a scanned path, optionally filtered by extension, age or minimum size. Only the 2000 largest files of each scan are kept, so small file filters may return fewer rows than asked. Needs a finished scan. Read only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | optional | Limit to files below this folder. Defaults to the most recent scan. |
| `limit` | integer | `25` | Maximum rows to return. |
| `extensions` | string[] | optional | Only these file types, for example [".iso", ".zip"]. |
| `older_than_days` | number | optional | Only files not modified for at least this many days. |
| `min_size_mb` | number | `0` | Hide files smaller than this many MB. |

### `cleanup_candidates`

Measure well known places that are normally safe to clear: temp folders, browser and package manager caches, crash dumps and similar. Each result has a risk level (safe, caution, review, system) and an id. Items marked clearable can be emptied with clear_cleanup_target. Does not need a scan. Read only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `min_size_mb` | number | `50` | Hide targets smaller than this many MB. |

### `clear_cleanup_target`

Permanently delete the contents of one clearable target from cleanup_candidates, for example user-temp or npm-cache. The folders are kept, only what is inside is removed. Files in use are skipped. Defaults to a dry run that only reports what would happen. Only ids from cleanup_candidates are accepted.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `id` | string | required | Target id from cleanup_candidates, for example user-temp. |
| `dry_run` | boolean | `true` | When true nothing is deleted. Set to false only after the user agreed. |

### `move_to_recycle_bin`

Send specific files or folders to the Windows Recycle Bin. Windows only. System folders, drive roots and standard user folders are refused. Defaults to a dry run. Space is only freed after the Recycle Bin is emptied, and Windows may delete items larger than the Recycle Bin limit permanently, so check sizes first.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `paths` | string[] | required | Exact absolute paths of files or folders. No wildcards. |
| `dry_run` | boolean | `true` | When true nothing is moved. Set to false only after the user agreed to this exact list. |
<!-- tools:end -->

This section is generated from the code by `npm run docs`, so it always matches what the server really offers.

## Safety model

Cleanup is where a tool like this can do harm, so the rules are strict and enforced in code, not in prompts.

| Guarantee | How |
|---|---|
| Nothing changes without a deliberate second step | `move_to_recycle_bin` and `clear_cleanup_target` default to `dry_run: true`. |
| System locations are untouchable | Drive roots, `Windows`, `Program Files`, `$Recycle.Bin`, `System Volume Information`, the user profile folder and the standard user folders (Documents, Desktop, Downloads, Pictures, Music, Videos, AppData) are refused. A folder that contains a protected folder is refused too. |
| No wildcards, no relative paths | Only exact absolute paths are accepted. |
| Your files go to the Recycle Bin, not into the void | `move_to_recycle_bin` never deletes permanently. |
| Permanent deletion is limited to regenerating caches | `clear_cleanup_target` only accepts ids from a built in list (temp folders, caches). It empties contents and keeps the folders. System files and the Downloads folder are never clearable. |
| Links are never followed | Symlinks and junctions are skipped, so a cleanup cannot escape into somewhere else. |
| Everything is logged | Real changes are appended to `~/.diskscout/actions.log` as JSON lines. |

Two things worth knowing about the Recycle Bin: moving files there does not free space until it is emptied, and Windows may delete items larger than the bin's limit permanently. The dry run shows sizes first so you can judge.

## How sizes are measured

- Sizes are **logical file sizes** in 1024 steps, the same units Windows shows. They can differ a little from space on disk because of cluster rounding, compression and sparse files.
- **OneDrive "online only" files** report their full size but take almost no space locally, so a OneDrive folder can look bigger than it is on disk.
- Items the account cannot read (often protected system folders) are counted and listed as `unreadable_items`, and their size is not included. Run your MCP client as administrator if you need them.
- Each scan keeps the 2000 largest files, which is why small file filters can return fewer rows than requested.
- Scans are kept in memory for the life of the server and the six most recent are retained. Restarting the server clears them.

## Limitations

- Cleanup targets are tuned for Windows. On macOS and Linux the scanning tools work fully, the target list is shorter, and there is no Recycle Bin support yet.
- It does not read file contents, find duplicates or look inside archives.
- It is a point in time scan. If files change while it runs, numbers are approximate.

## Development

```bash
npm install
npm run build        # compile TypeScript to dist/
npm test             # build and run all tests
npm run docs         # regenerate the tool reference in README.md and docs/index.html
npm run docs:check   # fail if the generated docs are stale (CI runs this)
```

Layout:

```
src/scanner.ts   parallel scanner, scan registry
src/guard.ts     protected path rules
src/targets.ts   known cleanup locations and their risk levels
src/ops.ts       Recycle Bin, clearing, audit log
src/tools.ts     tool definitions (single source of truth)
src/index.ts     MCP server over stdio
scripts/         docs generator
docs/            GitHub Pages site
test/            unit and end to end tests
```

When you add or change a tool, edit only `src/tools.ts`, run `npm run docs`, and commit. The README and the site pick it up automatically. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- Duplicate file finder (size first, then hash)
- Compare two scans to show what grew
- "Not opened in a year" report using access times
- Optional HTML treemap report
- Published npm package

## License

[MIT](LICENSE)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client: Client;
let root: string;

const text = (r: any) => r.content[0].text as string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "diskscout-e2e-"));
  await fs.mkdir(path.join(root, "big"));
  await fs.mkdir(path.join(root, "small"));
  await fs.writeFile(path.join(root, "big", "movie.mkv"), Buffer.alloc(4 * 1024 * 1024));
  await fs.writeFile(path.join(root, "big", "old.zip"), Buffer.alloc(2 * 1024 * 1024));
  await fs.writeFile(path.join(root, "small", "note.txt"), "hello");
  const old = new Date(Date.now() - 400 * 86400000);
  await fs.utimes(path.join(root, "big", "old.zip"), old, old);

  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dirname, "..", "src", "index.js")] }));
});

after(async () => {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("lists all tools with annotations", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["cleanup_candidates", "clear_cleanup_target", "list_drives", "move_to_recycle_bin", "scan_folder", "top_files", "top_folders"]);
  const rb = tools.find((t) => t.name === "move_to_recycle_bin")!;
  assert.equal(rb.annotations?.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "top_folders")!.annotations?.readOnlyHint, true);
});

test("list_drives returns at least one drive", async () => {
  const r: any = await client.callTool({ name: "list_drives", arguments: {} });
  assert.ok(r.structuredContent.drives.length >= 1);
});

test("queries before a scan explain what to do", async () => {
  const r: any = await client.callTool({ name: "top_folders", arguments: { path: root } });
  assert.equal(r.isError, true);
  assert.match(text(r), /scan_folder/);
});

test("scan, then top_folders and top_files", async () => {
  const scan: any = await client.callTool({ name: "scan_folder", arguments: { path: root } });
  assert.equal(scan.structuredContent.status, "done");
  assert.equal(scan.structuredContent.files, 3);

  const folders: any = await client.callTool({ name: "top_folders", arguments: { path: root } });
  assert.equal(folders.structuredContent.folders[0].path, path.join(root, "big"));
  assert.ok(folders.structuredContent.folders[0].percent_of_folder > 99);

  const files: any = await client.callTool({ name: "top_files", arguments: { path: root, limit: 5 } });
  assert.equal(path.basename(files.structuredContent.files[0].path), "movie.mkv");

  const old: any = await client.callTool({ name: "top_files", arguments: { path: root, older_than_days: 365 } });
  assert.equal(old.structuredContent.files.length, 1);
  assert.equal(path.basename(old.structuredContent.files[0].path), "old.zip");

  const byExt: any = await client.callTool({ name: "top_files", arguments: { path: root, extensions: ["mkv"] } });
  assert.equal(byExt.structuredContent.files.length, 1);

  const again: any = await client.callTool({ name: "scan_folder", arguments: { path: path.join(root, "big") } });
  assert.match(text(again), /Already covered/);
});

test("scan_folder rejects missing paths and files", async () => {
  const missing: any = await client.callTool({ name: "scan_folder", arguments: { path: path.join(root, "nope") } });
  assert.equal(missing.isError, true);
  const file: any = await client.callTool({ name: "scan_folder", arguments: { path: path.join(root, "small", "note.txt") } });
  assert.equal(file.isError, true);
});

test("move_to_recycle_bin dry run reports sizes and refuses protected paths", async () => {
  const r: any = await client.callTool({ name: "move_to_recycle_bin", arguments: { paths: [path.join(root, "big", "old.zip"), os.homedir(), "/"] } });
  const plan = r.structuredContent.plan;
  assert.equal(plan[0].allowed, true);
  assert.equal(plan[1].allowed, false);
  assert.equal(plan[2].allowed, false);
  assert.equal(r.structuredContent.dry_run, true);
  await fs.access(path.join(root, "big", "old.zip"));
});

test("move_to_recycle_bin real run is refused off Windows and deletes nothing", async () => {
  if (process.platform === "win32") return;
  const r: any = await client.callTool({ name: "move_to_recycle_bin", arguments: { paths: [path.join(root, "big", "old.zip")], dry_run: false } });
  assert.equal(r.isError, true);
  await fs.access(path.join(root, "big", "old.zip"));
});

test("cleanup tools handle unknown ids", async () => {
  const c: any = await client.callTool({ name: "cleanup_candidates", arguments: { min_size_mb: 0 } });
  assert.ok(Array.isArray(c.structuredContent.targets));
  const r: any = await client.callTool({ name: "clear_cleanup_target", arguments: { id: "does-not-exist" } });
  assert.equal(r.isError, true);
  const sys: any = await client.callTool({ name: "clear_cleanup_target", arguments: { id: "system-files", dry_run: false } });
  assert.equal(sys.isError, true);
});

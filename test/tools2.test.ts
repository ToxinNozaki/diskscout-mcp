import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseRobocopyLine, isRobocopyError } from "../src/robocopy.js";

let client: Client;
let root: string;
let fakeHome: string;
const text = (r: any) => r.content[0].text as string;
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "diskscout-t2-"));
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "diskscout-home-"));
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  await fs.mkdir(path.join(root, "proj", "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(root, "proj", "src"), { recursive: true });
  await fs.mkdir(path.join(root, "other", "Cache"), { recursive: true });
  await fs.writeFile(path.join(root, "proj", "node_modules", "pkg", "blob.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
  await fs.writeFile(path.join(root, "proj", "src", "index.ts"), "x");
  await fs.writeFile(path.join(root, "other", "Cache", "c.bin"), Buffer.alloc(2 * 1024 * 1024, 2));
  await fs.writeFile(path.join(root, "dup-a.iso"), big);
  await fs.writeFile(path.join(root, "other", "dup-b.iso"), big);
  await fs.writeFile(path.join(root, "same-size-different.iso"), Buffer.alloc(3 * 1024 * 1024, 9));
  const old = new Date(Date.now() - 200 * 86400000);
  await fs.utimes(path.join(root, "proj", "node_modules"), old, old);

  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(import.meta.dirname, "..", "src", "index.js")],
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome } as Record<string, string>,
    })
  );
  await call("scan_folder", { path: root });
});

after(async () => {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(fakeHome, { recursive: true, force: true });
});

test("robocopy log lines parse, odd names and errors included", () => {
  const f = parseRobocopyLine("\t\t      12345\t2024/05/01 12:34:56\tC:\\Users\\me\\My Docs\\tést file (1).txt");
  assert.deepEqual({ size: f?.size, path: f?.path }, { size: 12345, path: "C:\\Users\\me\\My Docs\\tést file (1).txt" });
  assert.equal(new Date(f!.mtimeMs).getFullYear(), 2024);
  assert.equal(parseRobocopyLine("\uFEFF   9999999999999\t2020/01/02 03:04:05\tD:\\big.iso")?.size, 9999999999999);
  assert.equal(parseRobocopyLine("2026/10/08 02:12:11 ERROR 5 (0x00000005) Scanning Source Directory C:\\x\\"), null);
  assert.equal(isRobocopyError("2026/10/08 02:12:11 ERROR 5 (0x00000005) Scanning Source Directory C:\\x\\"), true);
  assert.equal(isRobocopyError("      12345\t2024/05/01 12:34:56\tC:\\a.txt"), false);
  assert.equal(parseRobocopyLine("\t  \t\t   12345 2026/10/08 06:22:59\tC:\\a b\\tést file.bin\r")?.path, "C:\\a b\\tést file.bin");
  assert.equal(parseRobocopyLine(""), null);
});

test("find_dev_artifacts finds node_modules and reports age", async () => {
  const r = await call("find_dev_artifacts", { path: root, min_size_mb: 1 });
  assert.equal(r.structuredContent.folders.length, 1);
  assert.equal(path.basename(r.structuredContent.folders[0].path), "node_modules");
  assert.ok(r.structuredContent.folders[0].days_since_modified >= 199);
  assert.match(r.structuredContent.folders[0].restore_with, /install/);
  const none = await call("find_dev_artifacts", { path: root, min_size_mb: 1, older_than_days: 400 });
  assert.equal(none.structuredContent.folders.length, 0);
});

test("find_folders matches names with wildcards, case insensitively", async () => {
  const r = await call("find_folders", { names: ["cac*"], path: root });
  assert.equal(r.structuredContent.folders.length, 1);
  assert.equal(path.basename(r.structuredContent.folders[0].path), "Cache");
});

test("find_duplicates finds identical content and ignores same size different content", async () => {
  const r = await call("find_duplicates", { path: root, min_size_mb: 1 });
  assert.equal(r.structuredContent.groups.length, 1);
  const g = r.structuredContent.groups[0];
  assert.equal(g.copies, 2);
  assert.deepEqual(g.files.map((f: string) => path.basename(f)).sort(), ["dup-a.iso", "dup-b.iso"]);
  assert.equal(g.wasted_bytes, 3 * 1024 * 1024);
});

test("snapshots: save, list, change something, compare", async () => {
  const none = await call("compare_snapshot", {});
  assert.match(text(none), /No snapshots/);
  const saved = await call("save_snapshot", { path: root, name: "t2 snap" });
  assert.equal(saved.structuredContent.name, "t2-snap");
  const listed = await call("compare_snapshot", {});
  assert.equal(listed.structuredContent.snapshots.length, 1);

  await fs.writeFile(path.join(root, "other", "grown.bin"), Buffer.alloc(6 * 1024 * 1024, 3));
  await call("scan_folder", { path: root, rescan: true });
  const cmp = await call("compare_snapshot", { name: "t2-snap", min_change_mb: 1 });
  assert.ok(cmp.structuredContent.total_change_bytes >= 6 * 1024 * 1024);
  assert.ok(cmp.structuredContent.grew.some((g: any) => path.basename(g.path) === "other"));
  const missing = await call("compare_snapshot", { name: "nope" });
  assert.equal(missing.isError, true);
});

test("scan_status lists scans and can cancel", async () => {
  const s = await call("scan_status");
  assert.ok(s.structuredContent.scans.length >= 1);
  assert.equal(s.structuredContent.scans[0].status, "done");
  const bad = await call("scan_status", { cancel_path: root });
  assert.equal(bad.isError, true);
});

test("both engines give the same totals", async () => {
  const a = await call("scan_folder", { path: root, rescan: true, engine: "node" });
  const b = await call("scan_folder", { path: root, rescan: true, engine: "auto" });
  assert.equal(a.structuredContent.total_bytes, b.structuredContent.total_bytes);
  assert.equal(a.structuredContent.files, b.structuredContent.files);
  assert.ok(["node", "robocopy"].includes(b.structuredContent.engine));
  // On Windows the fast engine must really be used, otherwise a silent fallback would hide a bug.
  if (process.platform === "win32") assert.equal(b.structuredContent.engine, "robocopy", b.structuredContent.engine_note);
});

test("recycle bin tools are refused off Windows", async () => {
  if (process.platform === "win32") return;
  assert.equal((await call("recycle_bin_info")).isError, true);
  assert.equal((await call("empty_recycle_bin", { dry_run: false })).isError, true);
});

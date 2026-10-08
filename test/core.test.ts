import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatBytes, pct } from "../src/format.js";
import { checkPathAllowed, type GuardEnv } from "../src/guard.js";
import { ScanJob, findNode } from "../src/scanner.js";

const win: GuardEnv = { platform: "win32", systemDrive: "C:", home: "C:\\Users\\manden" };

test("formatBytes uses 1024 steps", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.00 KB");
  assert.equal(formatBytes(475.73 * 1024 ** 3), "476 GB");
  assert.equal(pct(1, 4), 25);
});

test("guard refuses system and root locations on Windows", () => {
  const refused = [
    "C:\\",
    "C:\\Windows",
    "C:\\Windows\\System32\\drivers",
    "C:\\Program Files\\Git",
    "C:\\Users",
    "C:\\Users\\manden",
    "C:\\Users\\manden\\Documents",
    "C:\\Users\\manden\\AppData\\Local",
    "C:\\Users\\Manden\\DOCUMENTS\\",
    "C:\\$Recycle.Bin",
    "C:\\pagefile.sys",
    "relative\\path",
    "C:\\Users\\manden\\Downloads\\*.zip",
  ];
  for (const p of refused) assert.equal(checkPathAllowed(p, win).ok, false, `should refuse ${p}`);
});

test("guard refuses folders that contain protected ones", () => {
  assert.equal(checkPathAllowed("D:\\", win).ok, false);
  assert.equal(checkPathAllowed("C:\\Users\\manden\\AppData", win).ok, false);
});

test("guard allows normal user content and the temp exceptions", () => {
  const allowed = [
    "C:\\Users\\manden\\Downloads\\old-installer.exe",
    "C:\\Users\\manden\\Videos\\render-01.mp4",
    "C:\\Users\\manden\\AppData\\Local\\Temp\\junk.tmp",
    "C:\\Windows\\Temp",
    "C:\\Windows\\SoftwareDistribution\\Download\\abc",
    "D:\\Backups\\old",
  ];
  for (const p of allowed) assert.equal(checkPathAllowed(p, win).ok, true, `should allow ${p}`);
});

test("guard on posix", () => {
  const posix: GuardEnv = { platform: "linux", systemDrive: "", home: "/home/me" };
  assert.equal(checkPathAllowed("/", posix).ok, false);
  assert.equal(checkPathAllowed("/etc/passwd", posix).ok, false);
  assert.equal(checkPathAllowed("/home/me", posix).ok, false);
  assert.equal(checkPathAllowed("/home/me/Documents", posix).ok, false);
  assert.equal(checkPathAllowed("/home/me/old/stuff.iso", posix).ok, true);
});

test("scanner totals sizes, tracks big files, skips symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskscout-"));
  await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
  await fs.mkdir(path.join(root, "c"));
  await fs.writeFile(path.join(root, "top.txt"), Buffer.alloc(100));
  await fs.writeFile(path.join(root, "a", "one.iso"), Buffer.alloc(5000));
  await fs.writeFile(path.join(root, "a", "b", "two.bin"), Buffer.alloc(3000));
  await fs.writeFile(path.join(root, "c", "three.log"), Buffer.alloc(10));
  await fs.symlink(path.join(root, "a"), path.join(root, "c", "loop"), "junction");

  const job = new ScanJob(root);
  await job.promise;
  assert.equal(job.status, "done");
  assert.equal(job.tree.size, 8110);
  assert.equal(job.tree.files, 4);
  assert.equal(job.tree.dirs, 3);
  assert.equal(job.skippedLinks, 1);
  assert.equal(job.topFiles[0].size, 5000);
  assert.equal(findNode(job, path.join(root, "a"))?.size, 8000);
  assert.equal(findNode(job, path.join(root, "a", "b"))?.size, 3000);
  assert.equal(findNode(job, path.join(root, "nope")), null);
  assert.equal(job.topExtensions()[0].ext, ".iso");
  await fs.rm(root, { recursive: true, force: true });
});

test("scanner reports a missing root as an error", async () => {
  const job = new ScanJob(path.join(os.tmpdir(), "diskscout-does-not-exist"));
  await job.promise;
  assert.equal(job.status, "error");
});

test("clearTarget empties contents but keeps the folder, and dry run changes nothing", async () => {
  const { clearTarget } = await import("../src/ops.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "diskscout-clear-"));
  await fs.mkdir(path.join(dir, "sub"));
  await fs.writeFile(path.join(dir, "a.tmp"), Buffer.alloc(2048));
  await fs.writeFile(path.join(dir, "sub", "b.tmp"), Buffer.alloc(1024));
  const target = { id: "test", label: "test", paths: [dir], risk: "safe" as const, clearable: true, notes: "" };

  const dry = await clearTarget(target, true);
  assert.equal(dry.before, 3072);
  assert.equal(dry.freed, 0);
  assert.equal((await fs.readdir(dir)).length, 2);

  const real = await clearTarget(target, false);
  assert.equal(real.freed, 3072);
  assert.equal((await fs.readdir(dir)).length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("clearTarget refuses protected paths", async () => {
  const { clearTarget } = await import("../src/ops.js");
  const report = await clearTarget({ id: "bad", label: "bad", paths: [os.homedir()], risk: "safe", clearable: true, notes: "" }, false);
  assert.equal(report.itemsRemoved, 0);
  assert.equal(report.skipped.length, 1);
});

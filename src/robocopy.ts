// Fast Windows scan engine.
//
// Node can only get a file's size by opening it (lstat), which is slow on Windows because
// every open goes through antivirus and cloud sync filters. Robocopy in list only mode
// reads sizes straight from the directory listing without opening anything, so it is much
// faster. We run several robocopy processes in parallel on different subfolders and read
// their Unicode logs. If anything looks wrong the scanner falls back to the standard engine.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScanJob } from "./scanner.js";

const FLAGS = ["/L", "/NJH", "/NJS", "/NDL", "/NC", "/NP", "/BYTES", "/FP", "/TS", "/XJ", "/R:0", "/W:0"];
const SPLIT_DEPTH = 2;

export interface RobocopyFile {
  size: number;
  mtimeMs: number;
  path: string;
}

// Robocopy prints a size and a timestamp before the path. Accept either order, because the
// exact layout differs between Windows versions and options.
const TS = String.raw`(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})`;
const SIZE_FIRST = new RegExp(String.raw`^\s*(\d+)\s+${TS}\s+(\S.*)$`);
const TS_FIRST = new RegExp(String.raw`^\s*${TS}\s+(\d+)\s+(\S.*)$`);
const ERROR_CODE = /\(0x[0-9A-Fa-f]{8}\)/;

function toFile(size: string, y: string, mo: string, d: string, h: string, mi: string, sec: string, p: string): RobocopyFile {
  return { size: Number(size), mtimeMs: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)).getTime(), path: p.replace(/\s+$/, "") };
}

export function parseRobocopyLine(line: string): RobocopyFile | null {
  let m = SIZE_FIRST.exec(line);
  if (m) return toFile(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
  m = TS_FIRST.exec(line);
  if (m) return toFile(m[7], m[1], m[2], m[3], m[4], m[5], m[6], m[8]);
  return null;
}

export function isRobocopyError(line: string): boolean {
  return ERROR_CODE.test(line);
}

interface TaskResult {
  code: number | null;
  spawnError?: string;
  files: number;
  errors: string[];
  /** First few raw log lines, kept for diagnostics. */
  sample: string[];
}

let counter = 0;

function runTask(src: string, recursive: boolean, tag: string, children: Set<ChildProcess>, onFile: (f: RobocopyFile) => void): Promise<TaskResult> {
  return new Promise((resolve) => {
    const logPath = path.join(os.tmpdir(), `diskscout-${tag}-${counter++}.log`);
    const dest = path.join(path.parse(src).root, `diskscout-null-${tag}`);
    const args = [src, dest, ...(recursive ? ["/E"] : []), ...FLAGS, `/UNILOG:${logPath}`];
    const child = spawn("robocopy.exe", args, { windowsHide: true, stdio: "ignore" });
    children.add(child);
    let settled = false;
    const finish = async (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      const result: TaskResult = { code, spawnError, files: 0, errors: [], sample: [] };
      if (!spawnError) {
        try {
          await readLog(logPath, (line) => {
            if (result.sample.length < 6 && line.trim()) result.sample.push(line.slice(0, 160));
            const f = parseRobocopyLine(line);
            if (f) {
              result.files++;
              onFile(f);
            } else if (isRobocopyError(line) && result.errors.length < 5) {
              result.errors.push(line.trim().slice(0, 200));
            }
          });
        } catch {
          // No log means robocopy produced nothing. The exit code tells the story.
        }
      }
      fs.promises.rm(logPath, { force: true }).catch(() => {});
      resolve(result);
    };
    child.on("error", (err) => void finish(null, (err as NodeJS.ErrnoException).code ?? err.message));
    child.on("close", (code) => void finish(code));
  });
}

/** Stream a UTF-16 log and call back once per line. */
function readLog(logPath: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(logPath, { encoding: "utf16le", highWaterMark: 4 * 1024 * 1024 });
    let rest = "";
    stream.on("data", (chunk) => {
      const text = rest + chunk;
      let start = 0;
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
        onLine(text.slice(start, i));
        start = i + 1;
      }
      rest = text.slice(start);
    });
    stream.on("end", () => {
      if (rest) onLine(rest);
      resolve();
    });
    stream.on("error", reject);
  });
}

let statusPromise: Promise<{ ok: boolean; reason?: string }> | undefined;

/** One time check that robocopy exists and its output parses the way we expect. */
export function robocopyStatus(): Promise<{ ok: boolean; reason?: string }> {
  statusPromise ??= (async () => {
    let dir: string | undefined;
    try {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "diskscout-selftest-"));
      const nested = path.join(dir, "sub folder", "deeper");
      await fs.promises.mkdir(nested, { recursive: true });
      const name = path.join(nested, "tést file.bin");
      await fs.promises.writeFile(name, Buffer.alloc(12345));
      const found: RobocopyFile[] = [];
      const res = await runTask(dir, true, "selftest", new Set(), (f) => found.push(f));
      if (res.spawnError) return { ok: false, reason: `robocopy not found (${res.spawnError})` };
      if (found.length !== 1) return { ok: false, reason: `self test saw ${found.length} files instead of 1, exit code ${res.code}, output ${JSON.stringify(res.sample)}` };
      if (found[0].size !== 12345) return { ok: false, reason: `self test size ${found[0].size} instead of 12345` };
      if (found[0].path.toLowerCase() !== name.toLowerCase()) return { ok: false, reason: `self test path mismatch (${found[0].path})` };
      if (Math.abs(Date.now() - found[0].mtimeMs) > 36 * 3600 * 1000) return { ok: false, reason: "self test timestamp mismatch" };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    } finally {
      if (dir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return statusPromise;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Scan `job.root` with robocopy. Shallow folders (the first levels) are read with Node so
 * the work can be split into many independent robocopy runs below them.
 */
export async function runRobocopyScan(job: ScanJob): Promise<{ ok: boolean; reason?: string }> {
  const children = new Set<ChildProcess>();
  job.onCancel(() => {
    for (const c of children) c.kill();
  });
  const tasks: string[] = [];
  const shallowFiles: Array<{ dir: string; file: string }> = [];

  const expand = async (dir: string, depth: number): Promise<void> => {
    if (job.cancelled) return;
    job.nodeForDir(dir);
    job.currentPath = dir;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      job.noteError(dir, err);
      return;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) job.skippedLinks++;
      else if (e.isDirectory()) subdirs.push(p);
      else if (e.isFile()) shallowFiles.push({ dir, file: p });
    }
    await Promise.all(
      subdirs.map(async (sub) => {
        if (depth + 1 < SPLIT_DEPTH) await expand(sub, depth + 1);
        else {
          job.nodeForDir(sub);
          tasks.push(sub);
        }
      })
    );
  };
  await expand(job.root, 0);

  // Files that sit directly in the shallow folders.
  await forEachLimit(shallowFiles, 64, (f) =>
    new Promise<void>((resolve) => {
      fs.lstat(f.file, (err, st) => {
        if (err) job.noteError(f.file, err);
        else {
          const node = job.nodeForDir(f.dir);
          if (node) job.addFile(node, f.file, st.size, st.mtimeMs);
        }
        resolve();
      });
    })
  );

  // Everything deeper, in parallel.
  const parallel = Math.max(2, Math.min(8, os.cpus().length));
  const tag = job.id;
  let fatal: string | undefined;
  await forEachLimit(tasks, parallel, async (src) => {
    if (job.cancelled || fatal) return;
    job.currentPath = src;
    const res = await runTask(src, true, tag, children, (f) => job.ingestFile(f.path, f.size, f.mtimeMs));
    if (res.spawnError) {
      fatal = `could not start robocopy (${res.spawnError})`;
      return;
    }
    // 8 and above means some items could not be read (permissions). Not fatal, but worth reporting.
    if (res.errors.length) for (const line of res.errors) job.noteError(line);
    else if ((res.code ?? 0) >= 8) job.noteError(src, { code: `ROBOCOPY_${res.code}` });
  });
  return fatal ? { ok: false, reason: fatal } : { ok: true };
}

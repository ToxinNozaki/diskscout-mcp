import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const IS_WIN = process.platform === "win32";

export interface DirNode {
  name: string;
  /** Total bytes in this folder including everything below it. */
  size: number;
  /** Bytes of files directly inside this folder. */
  ownSize: number;
  /** Total file count below this folder. */
  files: number;
  /** Total sub folder count below this folder. */
  dirs: number;
  children: DirNode[];
}

export interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export type ScanStatus = "running" | "done" | "error" | "cancelled";

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export interface ScanOptions {
  /** How many of the largest files to remember. 0 disables tracking. */
  keepTopFiles?: number;
  concurrency?: number;
}

export class ScanJob {
  readonly id = randomUUID().slice(0, 8);
  readonly startedAt = Date.now();
  finishedAt?: number;
  status: ScanStatus = "running";
  filesSeen = 0;
  dirsSeen = 0;
  bytesSeen = 0;
  skippedLinks = 0;
  errorCount = 0;
  errorSamples: string[] = [];
  currentPath = "";
  error?: string;
  tree: DirNode;
  topFiles: FileInfo[] = [];
  extBytes = new Map<string, number>();
  promise: Promise<void>;
  cancelled = false;

  private readonly sem: Semaphore;
  private readonly keep: number;

  constructor(readonly root: string, opts: ScanOptions = {}) {
    this.keep = opts.keepTopFiles ?? 2000;
    this.sem = new Semaphore(opts.concurrency ?? 48);
    this.tree = { name: root, size: 0, ownSize: 0, files: 0, dirs: 0, children: [] };
    this.promise = this.run();
  }

  get durationMs(): number {
    return (this.finishedAt ?? Date.now()) - this.startedAt;
  }

  cancel(): void {
    this.cancelled = true;
  }

  private noteError(p: string, err: unknown): void {
    this.errorCount++;
    if (this.errorSamples.length < 15) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "ERR";
      this.errorSamples.push(`${code}: ${p}`);
    }
  }

  private async run(): Promise<void> {
    try {
      const st = await fs.lstat(this.root);
      if (!st.isDirectory()) throw new Error(`Not a directory: ${this.root}`);
      await this.scanDir(this.root, this.tree);
      this.compact();
      this.status = this.cancelled ? "cancelled" : "done";
    } catch (err) {
      this.status = "error";
      this.error = (err as Error).message;
    } finally {
      this.finishedAt = Date.now();
    }
  }

  private async scanDir(dirPath: string, node: DirNode): Promise<void> {
    if (this.cancelled) return;
    this.currentPath = dirPath;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await this.sem.run(() => fs.readdir(dirPath, { withFileTypes: true }));
    } catch (err) {
      this.noteError(dirPath, err);
      return;
    }
    this.dirsSeen++;

    const subdirs: Array<{ entryPath: string; child: DirNode }> = [];
    const fileEntries: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        this.skippedLinks++;
        continue;
      }
      if (entry.isDirectory()) {
        const child: DirNode = { name: entry.name, size: 0, ownSize: 0, files: 0, dirs: 0, children: [] };
        node.children.push(child);
        subdirs.push({ entryPath, child });
      } else if (entry.isFile()) {
        fileEntries.push(entryPath);
      }
    }

    await Promise.all([
      ...fileEntries.map((filePath) =>
        this.sem.run(async () => {
          try {
            const st = await fs.lstat(filePath);
            node.ownSize += st.size;
            node.files++;
            this.filesSeen++;
            this.bytesSeen += st.size;
            this.trackFile(filePath, st.size, st.mtimeMs);
          } catch (err) {
            this.noteError(filePath, err);
          }
        })
      ),
      ...subdirs.map(({ entryPath, child }) => this.scanDir(entryPath, child)),
    ]);

    let size = node.ownSize;
    let files = node.files;
    let dirs = node.children.length;
    for (const c of node.children) {
      size += c.size;
      files += c.files;
      dirs += c.dirs;
    }
    node.size = size;
    node.files = files;
    node.dirs = dirs;
  }

  private trackFile(filePath: string, size: number, mtimeMs: number): void {
    const ext = path.extname(filePath).toLowerCase() || "(none)";
    this.extBytes.set(ext, (this.extBytes.get(ext) ?? 0) + size);
    if (this.keep <= 0) return;
    this.topFiles.push({ path: filePath, size, mtimeMs });
    if (this.topFiles.length > this.keep * 4) this.compact();
  }

  private compact(): void {
    if (this.keep <= 0) return;
    this.topFiles.sort((a, b) => b.size - a.size);
    if (this.topFiles.length > this.keep) this.topFiles.length = this.keep;
  }

  topExtensions(n = 8): Array<{ ext: string; size: number }> {
    return [...this.extBytes.entries()]
      .map(([ext, size]) => ({ ext, size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, n);
  }
}

/**
 * Quickly measure a folder (no file tracking). Used for cleanup target sizing.
 * With timeoutMs the scan stops early and returns what it saw so far, flagged as partial.
 */
export async function measureDir(dir: string, timeoutMs?: number): Promise<{ size: number; files: number; errors: number; partial: boolean } | null> {
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  const job = new ScanJob(dir, { keepTopFiles: 0, concurrency: 24 });
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs) timer = setTimeout(() => job.cancel(), timeoutMs);
  await job.promise;
  if (timer) clearTimeout(timer);
  if (job.status === "done") return { size: job.tree.size, files: job.tree.files, errors: job.errorCount, partial: false };
  if (job.status === "cancelled") return { size: job.bytesSeen, files: job.filesSeen, errors: job.errorCount, partial: true };
  return null;
}

export function samePath(a: string, b: string): boolean {
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `child` equals `parent` or lives somewhere below it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Walk the scanned tree down to an absolute path. */
export function findNode(job: ScanJob, abs: string): DirNode | null {
  if (!isWithin(job.root, abs)) return null;
  const rel = path.relative(job.root, abs);
  if (rel === "") return job.tree;
  let node = job.tree;
  for (const part of rel.split(path.sep)) {
    const next = node.children.find((c) => (IS_WIN ? c.name.toLowerCase() === part.toLowerCase() : c.name === part));
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Keeps scans in memory so follow up questions are instant. */
export class ScanRegistry {
  private jobs: ScanJob[] = [];
  private readonly maxJobs = 6;

  add(job: ScanJob): void {
    this.jobs.push(job);
    while (this.jobs.length > this.maxJobs) {
      const idx = this.jobs.findIndex((j) => j.status !== "running");
      if (idx === -1) break;
      this.jobs.splice(idx, 1);
    }
  }

  /** Best finished scan that contains `abs`: the most recent one with the deepest root. */
  findDone(abs: string): ScanJob | undefined {
    return this.jobs
      .filter((j) => j.status === "done" && isWithin(j.root, abs))
      .sort((a, b) => b.root.length - a.root.length || (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  }

  findRunning(abs: string): ScanJob | undefined {
    return this.jobs.find((j) => j.status === "running" && samePath(j.root, abs));
  }

  latestDone(): ScanJob | undefined {
    return [...this.jobs].filter((j) => j.status === "done").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  }

  list(): ScanJob[] {
    return [...this.jobs];
  }
}

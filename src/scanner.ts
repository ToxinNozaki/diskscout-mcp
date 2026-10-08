import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runRobocopyScan, robocopyStatus } from "./robocopy.js";

const IS_WIN = process.platform === "win32";

/** How many of the largest files each scan remembers. */
export const TOP_FILES_LIMIT = 5000;

export type Engine = "auto" | "node" | "robocopy";

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

export interface ScanOptions {
  /** How many of the largest files to remember. 0 disables tracking. */
  keepTopFiles?: number;
  /** Parallel file system operations for the node engine. */
  concurrency?: number;
  engine?: Engine;
}

export class ScanJob {
  readonly id = randomUUID().slice(0, 8);
  readonly startedAt = Date.now();
  finishedAt?: number;
  status: ScanStatus = "running";
  engineUsed: "node" | "robocopy" = "node";
  engineNote?: string;
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
  private cancelHooks: Array<() => void> = [];
  private dirIndex = new Map<string, DirNode>();

  private readonly keep: number;
  private readonly concurrency: number;
  private readonly wantedEngine: Engine;

  constructor(readonly root: string, opts: ScanOptions = {}) {
    this.keep = opts.keepTopFiles ?? TOP_FILES_LIMIT;
    this.concurrency = opts.concurrency ?? (IS_WIN ? 64 : 16);
    this.wantedEngine = opts.engine ?? "auto";
    this.tree = this.freshTree();
    this.promise = this.run();
  }

  get durationMs(): number {
    return (this.finishedAt ?? Date.now()) - this.startedAt;
  }

  get filesPerSecond(): number {
    const s = this.durationMs / 1000;
    return s > 0 ? Math.round(this.filesSeen / s) : 0;
  }

  cancel(): void {
    this.cancelled = true;
    for (const hook of this.cancelHooks) hook();
  }

  onCancel(hook: () => void): void {
    this.cancelHooks.push(hook);
  }

  noteError(p: string, err?: unknown): void {
    this.errorCount++;
    if (this.errorSamples.length < 15) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "ERR";
      this.errorSamples.push(`${code}: ${p}`);
    }
  }

  private freshTree(): DirNode {
    const tree: DirNode = { name: this.root, size: 0, ownSize: 0, files: 0, dirs: 0, children: [] };
    this.dirIndex = new Map([[this.key(this.root), tree]]);
    return tree;
  }

  private key(p: string): string {
    return IS_WIN ? p.toLowerCase() : p;
  }

  private reset(): void {
    this.filesSeen = 0;
    this.dirsSeen = 0;
    this.bytesSeen = 0;
    this.skippedLinks = 0;
    this.errorCount = 0;
    this.errorSamples = [];
    this.topFiles = [];
    this.extBytes = new Map();
    this.tree = this.freshTree();
  }

  private async run(): Promise<void> {
    try {
      const st = await fs.promises.lstat(this.root);
      if (!st.isDirectory()) throw new Error(`Not a directory: ${this.root}`);

      let useRobocopy = false;
      if (this.wantedEngine !== "node" && IS_WIN) {
        const status = await robocopyStatus();
        if (status.ok) useRobocopy = true;
        else this.engineNote = `Fast engine unavailable (${status.reason}). Used the standard engine.`;
      } else if (this.wantedEngine === "robocopy") {
        this.engineNote = "The robocopy engine only exists on Windows. Used the standard engine.";
      }

      if (useRobocopy) {
        this.engineUsed = "robocopy";
        const result = await runRobocopyScan(this);
        if (!result.ok && !this.cancelled) {
          this.engineNote = `Fast engine failed (${result.reason}). Fell back to the standard engine.`;
          this.reset();
          this.engineUsed = "node";
          await this.runNode();
        }
      } else {
        await this.runNode();
      }
      this.aggregate(this.tree);
      this.compact();
      this.dirIndex.clear();
      this.status = this.cancelled ? "cancelled" : "done";
    } catch (err) {
      this.status = "error";
      this.error = (err as Error).message;
    } finally {
      this.finishedAt = Date.now();
    }
  }

  /** Standard engine: parallel readdir plus lstat, driven by a small callback work queue. */
  private runNode(): Promise<void> {
    return new Promise<void>((resolve) => {
      const dirStack: Array<{ p: string; node: DirNode }> = [{ p: this.root, node: this.tree }];
      const fileQueue: Array<{ p: string; node: DirNode }> = [];
      let active = 0;

      const pump = (): void => {
        while (active < this.concurrency && !this.cancelled) {
          const f = fileQueue.pop();
          if (f) {
            active++;
            fs.lstat(f.p, (err, st) => {
              if (err) this.noteError(f.p, err);
              else this.addFile(f.node, f.p, st.size, st.mtimeMs);
              active--;
              pump();
            });
            continue;
          }
          const d = dirStack.pop();
          if (d) {
            active++;
            this.currentPath = d.p;
            fs.readdir(d.p, { withFileTypes: true }, (err, entries) => {
              if (err) {
                this.noteError(d.p, err);
              } else {
                this.dirsSeen++;
                for (const entry of entries) {
                  const entryPath = d.p + (d.p.endsWith(path.sep) ? "" : path.sep) + entry.name;
                  if (entry.isSymbolicLink()) {
                    this.skippedLinks++;
                  } else if (entry.isDirectory()) {
                    const child: DirNode = { name: entry.name, size: 0, ownSize: 0, files: 0, dirs: 0, children: [] };
                    d.node.children.push(child);
                    dirStack.push({ p: entryPath, node: child });
                  } else if (entry.isFile()) {
                    fileQueue.push({ p: entryPath, node: d.node });
                  }
                }
              }
              active--;
              pump();
            });
            continue;
          }
          break;
        }
        if (active === 0 && (this.cancelled || (fileQueue.length === 0 && dirStack.length === 0))) resolve();
      };
      pump();
    });
  }

  /** Record one file under a known folder node. */
  addFile(node: DirNode, filePath: string, size: number, mtimeMs: number): void {
    node.ownSize += size;
    node.files++;
    this.filesSeen++;
    this.bytesSeen += size;
    const ext = path.extname(filePath).toLowerCase() || "(none)";
    this.extBytes.set(ext, (this.extBytes.get(ext) ?? 0) + size);
    if (this.keep > 0) {
      this.topFiles.push({ path: filePath, size, mtimeMs });
      if (this.topFiles.length > this.keep * 4) this.compact();
    }
  }

  /** Record a file by absolute path, creating folder nodes as needed. Used by the robocopy engine. */
  ingestFile(filePath: string, size: number, mtimeMs: number): void {
    const dir = path.dirname(filePath);
    const node = this.nodeForDir(dir);
    if (!node) {
      this.noteError(filePath);
      return;
    }
    this.addFile(node, filePath, size, mtimeMs);
  }

  nodeForDir(dirPath: string): DirNode | null {
    const k = this.key(dirPath);
    const hit = this.dirIndex.get(k);
    if (hit) return hit;
    if (!isWithin(this.root, dirPath)) return null;
    const parentPath = path.dirname(dirPath);
    if (parentPath === dirPath) return null;
    const parent = this.nodeForDir(parentPath);
    if (!parent) return null;
    const node: DirNode = { name: path.basename(dirPath), size: 0, ownSize: 0, files: 0, dirs: 0, children: [] };
    parent.children.push(node);
    this.dirIndex.set(k, node);
    this.dirsSeen++;
    return node;
  }

  /** Turn per folder file counts into totals for the whole subtree. */
  private aggregate(node: DirNode): void {
    let size = node.ownSize;
    let files = node.files;
    let dirs = node.children.length;
    for (const c of node.children) {
      this.aggregate(c);
      size += c.size;
      files += c.files;
      dirs += c.dirs;
    }
    node.size = size;
    node.files = files;
    node.dirs = dirs;
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
    const st = await fs.promises.lstat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  const job = new ScanJob(dir, { keepTopFiles: 0 });
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

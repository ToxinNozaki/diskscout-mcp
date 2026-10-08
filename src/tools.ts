import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { formatBytes, mb, pct } from "./format.js";
import { ScanJob, TOP_FILES_LIMIT, findNode, isWithin, measureDir, type DirNode } from "./scanner.js";
import { buildTargets } from "./targets.js";
import { audit, clearTarget, guardEnv, sendToRecycleBin } from "./ops.js";
import { checkPathAllowed } from "./guard.js";
import { extraTools } from "./extra-tools.js";
import { fail, ok, noScanMessage, registry, resolveInput, sleep, type ToolDef } from "./shared.js";

export { registry };
export type { ToolDef, ToolResult } from "./shared.js";

function summarize(job: ScanJob) {
  return {
    scan_id: job.id,
    root: job.root,
    status: job.status,
    total_bytes: job.tree.size,
    total: formatBytes(job.tree.size),
    files: job.tree.files,
    folders: job.tree.dirs,
    duration_seconds: Math.round(job.durationMs / 100) / 10,
    engine: job.engineUsed,
    files_per_second: job.filesPerSecond,
    engine_note: job.engineNote,
    unreadable_items: job.errorCount,
    unreadable_samples: job.errorSamples.slice(0, 8),
    skipped_links: job.skippedLinks,
    top_extensions: job.topExtensions().map((e) => ({ ext: e.ext, bytes: e.size, size: formatBytes(e.size) })),
  };
}

function summaryText(job: ScanJob): string {
  const s = summarize(job);
  const lines = [
    `Scan of ${s.root} finished in ${s.duration_seconds}s (${s.files_per_second.toLocaleString()} files per second, ${s.engine} engine).`,
    `Total: ${s.total} in ${s.files.toLocaleString()} files and ${s.folders.toLocaleString()} folders.`,
    `Biggest file types: ${s.top_extensions.slice(0, 6).map((e) => `${e.ext} ${e.size}`).join(", ") || "none"}.`,
  ];
  if (s.unreadable_items) {
    lines.push(`${s.unreadable_items.toLocaleString()} items could not be read (usually permissions). Their size is not counted. Examples: ${s.unreadable_samples.slice(0, 3).join("; ")}`);
  }
  if (s.engine_note) lines.push(s.engine_note);
  if (s.skipped_links) lines.push(`${s.skipped_links.toLocaleString()} links and junctions were skipped to avoid double counting.`);
  lines.push("Next: top_folders to see where the space is, top_files for single large files.");
  return lines.join("\n");
}

async function drives() {
  const out: Array<{ drive: string; path: string; total_bytes: number; used_bytes: number; free_bytes: number }> = [];
  const candidates = process.platform === "win32" ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`) : ["/", os.homedir()];
  const seen = new Set<string>();
  for (const p of candidates) {
    try {
      const s = await fs.statfs(p);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const key = `${total}:${free}`;
      if (process.platform !== "win32" && seen.has(key)) continue;
      seen.add(key);
      if (total > 0) out.push({ drive: process.platform === "win32" ? p.slice(0, 2) : p, path: p, total_bytes: total, used_bytes: total - free, free_bytes: free });
    } catch {
      // Drive letter not in use or not ready.
    }
  }
  return out;
}

const baseTools: ToolDef[] = [
  {
    name: "list_drives",
    title: "List drives",
    description: "Show every drive with total, used and free space. Start here to see which drive is filling up.",
    inputSchema: {},
    readOnly: true,
    destructive: false,
    handler: async () => {
      const list = await drives();
      if (!list.length) return fail("Could not read any drives.");
      const rows = list.map((d) => ({ ...d, total: formatBytes(d.total_bytes), used: formatBytes(d.used_bytes), free: formatBytes(d.free_bytes), percent_used: pct(d.used_bytes, d.total_bytes) }));
      const text = rows.map((r) => `${r.drive}  ${r.used} used of ${r.total} (${r.percent_used}%), ${r.free} free`).join("\n");
      return ok(text, { drives: rows });
    },
  },
  {
    name: "scan_folder",
    title: "Scan a folder or drive",
    description:
      "Scan a folder or whole drive and remember the result so other tools answer instantly. Large drives can take a few minutes. The call waits up to wait_seconds, then reports progress. Call it again with the same path to keep waiting or to read the result. Read only.",
    inputSchema: {
      path: z.string().describe("Folder or drive to scan, for example C:\\ or C:\\Users\\me\\AppData. Use ~ for the home folder."),
      wait_seconds: z.number().int().min(0).max(50).default(30).describe("How long to wait for the scan before returning progress. 0 starts the scan and returns immediately."),
      rescan: z.boolean().default(false).describe("Ignore saved results and scan again."),
      engine: z.enum(["auto", "node", "robocopy"]).default("auto").describe("Scan engine. auto picks the fastest one that works (robocopy on Windows). Use node to compare or if results look wrong."),
    },
    readOnly: true,
    destructive: false,
    handler: async ({ path: p, wait_seconds, rescan, engine }) => {
      const abs = resolveInput(p);
      try {
        const st = await fs.stat(abs);
        if (!st.isDirectory()) return fail(`${abs} is a file. Pass a folder or drive.`);
      } catch {
        return fail(`Cannot find ${abs}. Check the path.`);
      }

      if (!rescan) {
        const done = registry.findDone(abs);
        if (done) {
          const ageMin = Math.round((Date.now() - (done.finishedAt ?? 0)) / 60000);
          const same = done.root.toLowerCase() === abs.toLowerCase();
          const note = same ? `Using the scan from ${ageMin} minute(s) ago. Pass rescan: true to refresh it.\n` : `Already covered by the scan of ${done.root} from ${ageMin} minute(s) ago. Pass rescan: true to scan ${abs} again.\n`;
          return ok(note + summaryText(done), summarize(done));
        }
      }

      let job = registry.findRunning(abs);
      if (!job) {
        job = new ScanJob(abs, { engine });
        registry.add(job);
      }
      const deadline = Date.now() + wait_seconds * 1000;
      while (job.status === "running" && Date.now() < deadline) {
        await Promise.race([job.promise, sleep(250)]);
      }
      if (job.status === "error") return fail(`Scan failed: ${job.error}`);
      if (job.status === "running") {
        const progress = { scan_id: job.id, root: job.root, status: "running", engine: job.engineUsed, files_seen: job.filesSeen, folders_seen: job.dirsSeen, bytes_seen: job.bytesSeen, seen: formatBytes(job.bytesSeen), elapsed_seconds: Math.round(job.durationMs / 1000), current_path: job.currentPath };
        return ok(`Still scanning ${job.root}: ${job.filesSeen.toLocaleString()} files, ${formatBytes(job.bytesSeen)} so far after ${progress.elapsed_seconds}s. Call scan_folder again with the same path to keep waiting.`, progress);
      }
      return ok(summaryText(job), summarize(job));
    },
  },
  {
    name: "top_folders",
    title: "Biggest folders",
    description: "List the biggest folders inside a scanned path, largest first, with each folder's share of the total. Needs a finished scan that covers the path. Read only.",
    inputSchema: {
      path: z.string().describe("Folder to look inside. Must be inside a scanned location."),
      depth: z.number().int().min(1).max(4).default(1).describe("How many levels down to include. 1 lists direct sub folders only."),
      limit: z.number().int().min(1).max(200).default(25).describe("Maximum rows to return."),
      min_size_mb: z.number().min(0).default(0).describe("Hide folders smaller than this many MB."),
    },
    readOnly: true,
    destructive: false,
    handler: async ({ path: p, depth, limit, min_size_mb }) => {
      const abs = resolveInput(p);
      const job = registry.findDone(abs);
      if (!job) return noScanMessage(abs);
      const base = findNode(job, abs);
      if (!base) return fail(`${abs} was not found in the scan of ${job.root}. It may be a file, or it was created after the scan.`);

      const rows: Array<{ path: string; depth: number; node: DirNode }> = [];
      const walk = (node: DirNode, nodePath: string, level: number) => {
        for (const c of node.children) {
          const cp = path.join(nodePath, c.name);
          rows.push({ path: cp, depth: level, node: c });
          if (level < depth) walk(c, cp, level + 1);
        }
      };
      walk(base, abs, 1);
      const minBytes = mb(min_size_mb);
      const shown = rows.filter((r) => r.node.size >= minBytes).sort((a, b) => b.node.size - a.node.size).slice(0, limit);
      const data = shown.map((r) => ({ path: r.path, depth: r.depth, size_bytes: r.node.size, size: formatBytes(r.node.size), percent_of_folder: pct(r.node.size, base.size), files: r.node.files, folders: r.node.dirs }));
      const header = `${abs}: ${formatBytes(base.size)} total (${formatBytes(base.ownSize)} in files directly inside it).`;
      const body = data.map((d) => `${d.size.padStart(9)}  ${String(d.percent_of_folder).padStart(5)}%  ${d.path}`).join("\n");
      return ok(`${header}\n${body || "No sub folders match."}`, { path: abs, total_bytes: base.size, own_files_bytes: base.ownSize, folders: data });
    },
  },
  {
    name: "top_files",
    title: "Biggest files",
    description:
      `List the largest files in a scanned path, optionally filtered by extension, age or minimum size. Only the ${TOP_FILES_LIMIT} largest files of each scan are kept, so small file filters may return fewer rows than asked. Needs a finished scan. Read only.`,
    inputSchema: {
      path: z.string().optional().describe("Limit to files below this folder. Defaults to the most recent scan."),
      limit: z.number().int().min(1).max(200).default(25).describe("Maximum rows to return."),
      extensions: z.array(z.string()).optional().describe("Only these file types, for example [\".iso\", \".zip\"]."),
      older_than_days: z.number().min(0).optional().describe("Only files not modified for at least this many days."),
      min_size_mb: z.number().min(0).default(0).describe("Hide files smaller than this many MB."),
    },
    readOnly: true,
    destructive: false,
    handler: async ({ path: p, limit, extensions, older_than_days, min_size_mb }) => {
      let job: ScanJob | undefined;
      let abs: string;
      if (p) {
        abs = resolveInput(p);
        job = registry.findDone(abs);
        if (!job) return noScanMessage(abs);
      } else {
        job = registry.latestDone();
        if (!job) return fail("No finished scan yet. Call scan_folder first.");
        abs = job.root;
      }
      const exts = extensions?.map((e: string) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
      const cutoff = older_than_days != null ? Date.now() - older_than_days * 86400000 : Infinity;
      const minBytes = mb(min_size_mb);
      const matches = job.topFiles
        .filter((f) => isWithin(abs, f.path) && f.size >= minBytes && (!exts || exts.includes(path.extname(f.path).toLowerCase())) && f.mtimeMs <= cutoff)
        .slice(0, limit);
      const data = matches.map((f) => ({ path: f.path, size_bytes: f.size, size: formatBytes(f.size), modified: new Date(f.mtimeMs).toISOString().slice(0, 10), days_since_modified: Math.floor((Date.now() - f.mtimeMs) / 86400000) }));
      const text = data.length ? data.map((d) => `${d.size.padStart(9)}  ${d.modified}  ${d.path}`).join("\n") : `No files match. Only the ${TOP_FILES_LIMIT} largest files of the scan are searched.`;
      return ok(text, { path: abs, files: data });
    },
  },
  {
    name: "cleanup_candidates",
    title: "Known cleanup targets",
    description:
      "Measure well known places that are normally safe to clear: temp folders, browser and package manager caches, crash dumps and similar. Each result has a risk level (safe, caution, review, system) and an id. Items marked clearable can be emptied with clear_cleanup_target. Does not need a scan. Read only.",
    inputSchema: {
      min_size_mb: z.number().min(0).default(50).describe("Hide targets smaller than this many MB."),
    },
    readOnly: true,
    destructive: false,
    handler: async ({ min_size_mb }) => {
      const targets = await buildTargets({ platform: process.platform, env: process.env, home: os.homedir() });
      const sized = await Promise.all(
        targets.map(async (t) => {
          let size = 0;
          let unreadable = 0;
          let partialFlag = false;
          for (const p of t.paths) {
            try {
              const st = await fs.lstat(p);
              if (st.isFile()) size += st.size;
              else {
                const m = await measureDir(p, 25000);
                size += m?.size ?? 0;
                unreadable += m?.errors ?? 0;
                if (m?.partial) partialFlag = true;
              }
            } catch {
              // Missing or locked, skip.
            }
          }
          return { id: t.id, label: t.label, risk: t.risk, clearable: t.clearable, size_bytes: size, size: (partialFlag ? "at least " : "") + formatBytes(size), paths: t.paths, notes: t.notes, unreadable_items: unreadable };
        })
      );
      const minBytes = mb(min_size_mb);
      const rows = sized.filter((r) => r.size_bytes >= minBytes).sort((a, b) => b.size_bytes - a.size_bytes);
      const clearableTotal = rows.filter((r) => r.clearable && (r.risk === "safe" || r.risk === "caution")).reduce((s, r) => s + r.size_bytes, 0);
      const text = rows.length
        ? rows.map((r) => `${r.size.padStart(9)}  [${r.risk}${r.clearable ? ", clearable" : ""}]  ${r.id}: ${r.label}\n           ${r.notes}`).join("\n") + `\nClearable total: ${formatBytes(clearableTotal)}`
        : "Nothing above the size threshold.";
      return ok(text, { targets: rows, clearable_total_bytes: clearableTotal });
    },
  },
  {
    name: "clear_cleanup_target",
    title: "Clear a cleanup target",
    description:
      "Permanently delete the contents of one clearable target from cleanup_candidates, for example user-temp or npm-cache. The folders are kept, only what is inside is removed. Files in use are skipped. Defaults to a dry run that only reports what would happen. Only ids from cleanup_candidates are accepted.",
    inputSchema: {
      id: z.string().describe("Target id from cleanup_candidates, for example user-temp."),
      dry_run: z.boolean().default(true).describe("When true nothing is deleted. Set to false only after the user agreed."),
    },
    readOnly: false,
    destructive: true,
    handler: async ({ id, dry_run }) => {
      const targets = await buildTargets({ platform: process.platform, env: process.env, home: os.homedir() });
      const target = targets.find((t) => t.id === id);
      if (!target) return fail(`Unknown target "${id}". Run cleanup_candidates to see valid ids.`);
      if (!target.clearable) return fail(`${id} cannot be cleared automatically. ${target.notes}`);
      const report = await clearTarget(target, dry_run);
      const text = dry_run
        ? `Dry run for ${id}: ${formatBytes(report.before)} across ${report.itemsRemoved} top level items would be deleted. Nothing was changed. Run again with dry_run false to delete.`
        : `Cleared ${id}: freed ${formatBytes(report.freed)} (${formatBytes(report.before)} to ${formatBytes(report.after)}). ${report.itemsFailed} item(s) were in use or protected and were left alone.`;
      return ok(text + (report.skipped.length ? `\nSkipped: ${report.skipped.join("; ")}` : ""), { ...report, freed_human: formatBytes(report.freed) });
    },
  },
  {
    name: "move_to_recycle_bin",
    title: "Move to Recycle Bin",
    description:
      "Send specific files or folders to the Windows Recycle Bin. Windows only. System folders, drive roots and standard user folders are refused. Defaults to a dry run. Space is only freed after the Recycle Bin is emptied, and Windows may delete items larger than the Recycle Bin limit permanently, so check sizes first.",
    inputSchema: {
      paths: z.array(z.string()).min(1).max(50).describe("Exact absolute paths of files or folders. No wildcards."),
      dry_run: z.boolean().default(true).describe("When true nothing is moved. Set to false only after the user agreed to this exact list."),
    },
    readOnly: false,
    destructive: true,
    handler: async ({ paths, dry_run }) => {
      const env = guardEnv();
      const plan: Array<{ path: string; size_bytes: number; size: string; allowed: boolean; reason?: string }> = [];
      for (const raw of paths as string[]) {
        const check = checkPathAllowed(raw, env);
        let size = 0;
        let partial = false;
        let exists = true;
        try {
          const st = await fs.lstat(raw);
          if (!check.ok) size = 0;
          else if (!st.isDirectory()) size = st.size;
          else {
            const abs = path.resolve(raw);
            const scanned = registry.findDone(abs);
            const node = scanned ? findNode(scanned, abs) : null;
            if (node) size = node.size;
            else {
              const m = await measureDir(raw, 15000);
              size = m?.size ?? 0;
              partial = m?.partial ?? false;
            }
          }
        } catch {
          exists = false;
        }
        const allowed = check.ok && exists;
        plan.push({ path: raw, size_bytes: size, size: (partial ? "at least " : "") + formatBytes(size), allowed, reason: !check.ok ? check.reason : !exists ? "Path does not exist." : undefined });
      }
      const refused = plan.filter((p) => !p.allowed);
      const allowedItems = plan.filter((p) => p.allowed);
      const total = allowedItems.reduce((s, p) => s + p.size_bytes, 0);
      const lines = plan.map((p) => `${p.allowed ? "OK     " : "REFUSED"} ${p.size.padStart(9)}  ${p.path}${p.reason ? `  (${p.reason})` : ""}`);

      if (dry_run) {
        return ok(`Dry run. Nothing was moved.\n${lines.join("\n")}\n${allowedItems.length} item(s), ${formatBytes(total)} would go to the Recycle Bin.`, { dry_run: true, plan });
      }
      if (process.platform !== "win32") return fail("Recycle Bin support is Windows only. Use the dry run to review, then delete in your file manager.");
      if (!allowedItems.length) return fail(`Nothing to do.\n${lines.join("\n")}`);

      const results = await sendToRecycleBin(allowedItems.map((p) => p.path));
      await audit({ action: "recycle", results });
      const moved = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      const text = `Moved ${moved} of ${allowedItems.length} item(s) to the Recycle Bin (${formatBytes(total)} before failures). Empty the Recycle Bin to actually free the space.` + (failed.length ? `\nFailed: ${failed.map((f) => `${f.path} (${f.error})`).join("; ")}` : "") + (refused.length ? `\nRefused: ${refused.length}` : "");
      return ok(text, { dry_run: false, results, refused });
    },
  },
];

export const tools: ToolDef[] = [...baseTools, ...extraTools];

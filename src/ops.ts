import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { measureDir } from "./scanner.js";
import type { CleanupTarget } from "./targets.js";
import { checkPathAllowed, type GuardEnv } from "./guard.js";

export function guardEnv(): GuardEnv {
  return {
    platform: process.platform,
    systemDrive: process.env.SystemDrive ?? "C:",
    home: os.homedir(),
  };
}

/** Every change this server makes is appended to ~/.diskscout/actions.log. */
export async function audit(entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.join(os.homedir(), ".diskscout");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "actions.log"), JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Logging must never break the actual operation.
  }
}

const RECYCLE_SCRIPT = `
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = $env:DISKSCOUT_PATHS | ConvertFrom-Json
$results = foreach ($p in $paths) {
  try {
    if (Test-Path -LiteralPath $p -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    [pscustomobject]@{ path = $p; ok = $true }
  } catch {
    [pscustomobject]@{ path = $p; ok = $false; error = $_.Exception.Message }
  }
}
ConvertTo-Json -InputObject @($results) -Compress
`;

export interface RecycleResult {
  path: string;
  ok: boolean;
  error?: string;
}

/** Send paths to the Windows Recycle Bin. Paths travel in an environment variable, never in the command line. */
export function sendToRecycleBin(paths: string[]): Promise<RecycleResult[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", RECYCLE_SCRIPT],
      { env: { ...process.env, DISKSCOUT_PATHS: JSON.stringify(paths) }, timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          reject(new Error(`Unexpected PowerShell output: ${stdout.slice(0, 200)}`));
        }
      }
    );
  });
}

export interface ClearReport {
  targetId: string;
  dryRun: boolean;
  before: number;
  after: number;
  freed: number;
  itemsRemoved: number;
  itemsFailed: number;
  skipped: string[];
}

/** Empty the contents of a cleanup target. The folders themselves are kept. */
export async function clearTarget(target: CleanupTarget, dryRun: boolean): Promise<ClearReport> {
  const env = guardEnv();
  let before = 0;
  let itemsRemoved = 0;
  let itemsFailed = 0;
  const skipped: string[] = [];
  const work: Array<{ child: string }> = [];

  for (const dir of target.paths) {
    const allowed = checkPathAllowed(dir, env);
    if (!allowed.ok) {
      skipped.push(`${dir} (${allowed.reason})`);
      continue;
    }
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      skipped.push(`${dir} (not a plain folder)`);
      continue;
    }
    const m = await measureDir(dir);
    before += m?.size ?? 0;
    let children: string[] = [];
    try {
      children = await fs.readdir(dir);
    } catch {
      skipped.push(`${dir} (cannot read)`);
      continue;
    }
    for (const c of children) work.push({ child: path.join(dir, c) });
  }

  if (dryRun) {
    return { targetId: target.id, dryRun, before, after: before, freed: 0, itemsRemoved: work.length, itemsFailed: 0, skipped };
  }

  const queue = [...work];
  const workers = Array.from({ length: 8 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        await fs.rm(item.child, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
        itemsRemoved++;
      } catch {
        itemsFailed++;
      }
    }
  });
  await Promise.all(workers);

  let after = 0;
  for (const dir of target.paths) after += (await measureDir(dir))?.size ?? 0;
  const freed = Math.max(0, before - after);
  await audit({ action: "clear_target", target: target.id, paths: target.paths, freedBytes: freed, itemsRemoved, itemsFailed });
  return { targetId: target.id, dryRun, before, after, freed, itemsRemoved, itemsFailed, skipped };
}

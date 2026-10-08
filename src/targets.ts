import { promises as fs } from "node:fs";
import path from "node:path";

export type Risk = "safe" | "caution" | "review" | "system";

export interface CleanupTarget {
  id: string;
  label: string;
  paths: string[];
  risk: Risk;
  /** True when diskscout may empty it itself (contents only, never the folder). */
  clearable: boolean;
  notes: string;
}

export interface TargetEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

const j = (p: NodeJS.Platform, ...parts: string[]) => (p === "win32" ? path.win32.join(...parts) : path.posix.join(...parts));

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Chromium based browsers keep one cache per profile. Find them all. */
async function chromiumCaches(userData: string, platform: NodeJS.Platform): Promise<string[]> {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(userData);
  } catch {
    return out;
  }
  const profiles = entries.filter((e) => e === "Default" || /^Profile \d+$/.test(e));
  for (const prof of profiles) {
    for (const sub of ["Cache", "Code Cache", "GPUCache", j(platform, "Service Worker", "CacheStorage")]) {
      const p = j(platform, userData, prof, sub);
      if (await exists(p)) out.push(p);
    }
  }
  return out;
}

async function existing(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) if (await exists(p)) out.push(p);
  return out;
}

export async function buildTargets(t: TargetEnv): Promise<CleanupTarget[]> {
  const { platform, env, home } = t;
  const targets: CleanupTarget[] = [];
  const add = async (target: Omit<CleanupTarget, "paths"> & { paths: string[] }) => {
    const paths = await existing(target.paths);
    if (paths.length) targets.push({ ...target, paths });
  };

  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? j(platform, home, "AppData", "Local");
    const roaming = env.APPDATA ?? j(platform, home, "AppData", "Roaming");
    const sysRoot = env.SystemRoot ?? "C:\\Windows";
    const sysDrive = env.SystemDrive ?? "C:";

    await add({ id: "user-temp", label: "User temp files", paths: [env.TEMP ?? j(platform, local, "Temp")], risk: "safe", clearable: true, notes: "Leftovers from installers and apps. Files in use are skipped automatically." });
    await add({ id: "windows-temp", label: "Windows temp files", paths: [j(platform, sysRoot, "Temp")], risk: "safe", clearable: true, notes: "System temp folder. Some files need admin rights and will be skipped." });
    await add({ id: "windows-update-download", label: "Windows Update download cache", paths: [j(platform, sysRoot, "SoftwareDistribution", "Download")], risk: "safe", clearable: true, notes: "Already installed update files. Needs admin rights. Settings > System > Storage > Temporary files does the same job." });
    await add({ id: "crash-dumps", label: "Crash dumps", paths: [j(platform, local, "CrashDumps"), j(platform, sysRoot, "Minidump")], risk: "safe", clearable: true, notes: "Only useful for debugging crashes." });
    await add({ id: "windows-old", label: "Previous Windows installation", paths: [j(platform, sysDrive + "\\", "Windows.old")], risk: "caution", clearable: false, notes: "Remove it through Settings > System > Storage > Temporary files > Previous Windows installation. Do not delete by hand." });

    await add({ id: "npm-cache", label: "npm cache", paths: [j(platform, local, "npm-cache"), j(platform, roaming, "npm-cache")], risk: "safe", clearable: true, notes: "Re-downloaded on demand." });
    await add({ id: "pip-cache", label: "pip cache", paths: [j(platform, local, "pip", "Cache")], risk: "safe", clearable: true, notes: "Re-downloaded on demand." });
    await add({ id: "yarn-cache", label: "Yarn cache", paths: [j(platform, local, "Yarn", "Cache")], risk: "safe", clearable: true, notes: "Re-downloaded on demand." });
    await add({ id: "bun-cache", label: "Bun install cache", paths: [j(platform, home, ".bun", "install", "cache")], risk: "safe", clearable: true, notes: "Re-downloaded on demand." });
    await add({ id: "nuget-http-cache", label: "NuGet HTTP cache", paths: [j(platform, local, "NuGet", "v3-cache")], risk: "safe", clearable: true, notes: "Re-downloaded on demand." });
    await add({ id: "nuget-packages", label: "NuGet global packages", paths: [j(platform, home, ".nuget", "packages")], risk: "caution", clearable: true, notes: "Restored on the next build, so the first build after clearing is slower and needs internet." });
    await add({ id: "gradle-caches", label: "Gradle caches", paths: [j(platform, home, ".gradle", "caches")], risk: "caution", clearable: true, notes: "Rebuilt on the next Gradle run. Slower first build, needs internet." });
    await add({ id: "cargo-registry", label: "Cargo registry cache", paths: [j(platform, home, ".cargo", "registry")], risk: "caution", clearable: true, notes: "Re-downloaded on the next cargo build." });
    await add({ id: "conda-pkgs", label: "Conda package cache", paths: [j(platform, home, ".conda", "pkgs")], risk: "caution", clearable: true, notes: "Re-downloaded when environments are rebuilt." });

    await add({ id: "chrome-cache", label: "Google Chrome cache", paths: await chromiumCaches(j(platform, local, "Google", "Chrome", "User Data"), platform), risk: "safe", clearable: true, notes: "Close Chrome first for best results. Logins and bookmarks are not touched." });
    await add({ id: "edge-cache", label: "Microsoft Edge cache", paths: await chromiumCaches(j(platform, local, "Microsoft", "Edge", "User Data"), platform), risk: "safe", clearable: true, notes: "Close Edge first for best results." });
    await add({ id: "brave-cache", label: "Brave cache", paths: await chromiumCaches(j(platform, local, "BraveSoftware", "Brave-Browser", "User Data"), platform), risk: "safe", clearable: true, notes: "Close Brave first for best results." });
    await add({ id: "opera-cache", label: "Opera / Opera GX cache", paths: await existing(["Opera GX Stable", "Opera Stable"].flatMap((n) => ["Cache", "Code Cache", "GPUCache"].flatMap((s) => [j(platform, roaming, "Opera Software", n, s), j(platform, local, "Opera Software", n, s)]))), risk: "safe", clearable: true, notes: "Close Opera first for best results." });
    await add({ id: "discord-cache", label: "Discord cache", paths: ["Cache", "Code Cache", "GPUCache"].map((s) => j(platform, roaming, "discord", s)), risk: "safe", clearable: true, notes: "Close Discord first. Rebuilt automatically." });
    await add({ id: "vscode-cache", label: "VS Code caches", paths: ["Cache", "CachedData", "CachedExtensionVSIXs", "GPUCache"].map((s) => j(platform, roaming, "Code", s)), risk: "safe", clearable: true, notes: "Rebuilt automatically." });
    await add({ id: "adobe-media-cache", label: "Adobe media cache", paths: [j(platform, roaming, "Adobe", "Common", "Media Cache Files"), j(platform, roaming, "Adobe", "Common", "Media Cache")], risk: "safe", clearable: true, notes: "Premiere and After Effects regenerate it, previews may need re-rendering." });
    await add({ id: "steam-caches", label: "Steam shader and download caches", paths: ["C:\\Program Files (x86)\\Steam\\steamapps\\shadercache", "C:\\Program Files (x86)\\Steam\\depotcache", "C:\\Program Files (x86)\\Steam\\steamapps\\downloading"], risk: "caution", clearable: false, notes: "Shader caches are rebuilt by games. Clear from Steam settings > Downloads instead." });

    await add({ id: "downloads-folder", label: "Downloads folder", paths: [j(platform, home, "Downloads")], risk: "review", clearable: false, notes: "Your files. Look through top_files here and decide item by item." });
    await add({ id: "system-files", label: "Hibernation, page and swap files", paths: [j(platform, sysDrive + "\\", "hiberfil.sys"), j(platform, sysDrive + "\\", "pagefile.sys"), j(platform, sysDrive + "\\", "swapfile.sys")], risk: "system", clearable: false, notes: "Managed by Windows. Hibernation can be turned off with an admin terminal: powercfg /h off. Only do that if you do not use hibernate or Fast Startup." });
  } else {
    const cache = env.XDG_CACHE_HOME ?? j(platform, home, ".cache");
    await add({ id: "user-cache", label: "User cache folder", paths: [platform === "darwin" ? j(platform, home, "Library", "Caches") : cache], risk: "caution", clearable: false, notes: "Contains many app caches. Look at the biggest subfolders first." });
    await add({ id: "npm-cache", label: "npm cache", paths: [j(platform, home, ".npm", "_cacache")], risk: "safe", clearable: true, notes: "Re-downloaded on demand." });
    await add({ id: "pip-cache", label: "pip cache", paths: [j(platform, cache, "pip")], risk: "safe", clearable: true, notes: "Re-downloaded on demand." });
    await add({ id: "gradle-caches", label: "Gradle caches", paths: [j(platform, home, ".gradle", "caches")], risk: "caution", clearable: true, notes: "Rebuilt on the next Gradle run." });
    await add({ id: "cargo-registry", label: "Cargo registry cache", paths: [j(platform, home, ".cargo", "registry")], risk: "caution", clearable: true, notes: "Re-downloaded on the next cargo build." });
    await add({ id: "trash", label: "Trash", paths: [platform === "darwin" ? j(platform, home, ".Trash") : j(platform, home, ".local", "share", "Trash")], risk: "review", clearable: false, notes: "Empty it from your file manager." });
  }
  return targets;
}

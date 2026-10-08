import path from "node:path";

export interface GuardEnv {
  platform: NodeJS.Platform;
  systemDrive: string; // e.g. "C:"
  home: string;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

function norm(p: string, platform: NodeJS.Platform): string {
  const pathMod = platform === "win32" ? path.win32 : path.posix;
  let n = pathMod.normalize(p);
  if (n.length > 3 && (n.endsWith("\\") || n.endsWith("/"))) n = n.slice(0, -1);
  return platform === "win32" ? n.toLowerCase() : n;
}

function windowsRules(env: GuardEnv) {
  const sd = env.systemDrive.toLowerCase();
  const home = norm(env.home, "win32");
  // Block the folder itself and everything below it.
  const trees = [
    `${sd}\\windows`,
    `${sd}\\program files`,
    `${sd}\\program files (x86)`,
    `${sd}\\$recycle.bin`,
    `${sd}\\system volume information`,
    `${sd}\\boot`,
    `${sd}\\recovery`,
    `${sd}\\efi`,
  ];
  // Block only the folder itself. Things inside are the user's business.
  const exact = [
    `${sd}\\users`,
    `${sd}\\programdata`,
    home,
    `${home}\\desktop`,
    `${home}\\documents`,
    `${home}\\downloads`,
    `${home}\\pictures`,
    `${home}\\music`,
    `${home}\\videos`,
    `${home}\\appdata`,
    `${home}\\appdata\\local`,
    `${home}\\appdata\\roaming`,
    `${home}\\appdata\\locallow`,
    `${home}\\onedrive`,
    `${sd}\\pagefile.sys`,
    `${sd}\\hiberfil.sys`,
    `${sd}\\swapfile.sys`,
  ];
  // Specific places under a blocked tree that are fine to touch.
  const exceptions = [`${sd}\\windows\\temp`, `${sd}\\windows\\softwaredistribution\\download`, `${sd}\\windows.old`];
  return { trees, exact, exceptions };
}

function posixRules(env: GuardEnv) {
  const trees = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/sbin", "/sys", "/usr", "/var/lib", "/system", "/library", "/applications", "/private/etc"];
  const exact = ["/", "/home", "/root", "/var", "/opt", "/users", "/mnt", "/media", env.home, ...["documents", "desktop", "downloads", "pictures", "music", "videos"].flatMap((d) => [`${env.home}/${d}`, `${env.home}/${d[0].toUpperCase()}${d.slice(1)}`])];
  return { trees, exact, exceptions: [] as string[] };
}

/**
 * Decide whether a path may be sent to the Recycle Bin.
 * Conservative on purpose: when in doubt, refuse.
 */
export function checkPathAllowed(input: string, env: GuardEnv): GuardResult {
  const pathMod = env.platform === "win32" ? path.win32 : path.posix;
  if (!input || typeof input !== "string") return { ok: false, reason: "Empty path." };
  if (!pathMod.isAbsolute(input)) return { ok: false, reason: "Path must be absolute." };
  if (input.includes("\0")) return { ok: false, reason: "Invalid path." };
  if (/[*?]/.test(input)) return { ok: false, reason: "Wildcards are not allowed. Pass exact paths." };

  const p = norm(input, env.platform);
  const parsed = pathMod.parse(input);
  if (norm(parsed.root, env.platform) === p) return { ok: false, reason: "Refusing to touch a drive or filesystem root." };

  const rules = env.platform === "win32" ? windowsRules(env) : posixRules(env);
  const lower = (s: string) => (env.platform === "win32" ? s.toLowerCase() : s);
  const exceptions = rules.exceptions.map((e) => norm(e, env.platform));
  const within = (parent: string, child: string) => child === parent || child.startsWith(parent + (env.platform === "win32" ? "\\" : "/"));

  const excepted = exceptions.some((e) => within(e, p));

  for (const raw of rules.exact) {
    const e = norm(raw, env.platform);
    if (p === e) return { ok: false, reason: `Protected location: ${input}` };
    // Deleting an ancestor of a protected folder would delete the folder too.
    if (within(p, e)) return { ok: false, reason: `This folder contains a protected location (${raw}).` };
  }
  for (const raw of rules.trees) {
    const t = norm(lower(raw), env.platform);
    if (within(t, p) && !excepted) return { ok: false, reason: `Protected system location: ${raw}` };
    if (within(p, t)) return { ok: false, reason: `This folder contains a protected system location (${raw}).` };
  }
  return { ok: true };
}

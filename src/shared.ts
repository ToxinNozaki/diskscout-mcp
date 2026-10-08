import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ScanRegistry, isWithin } from "./scanner.js";

export const registry = new ScanRegistry();

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  readOnly: boolean;
  destructive: boolean;
  handler: (args: any) => Promise<ToolResult>;
}

export const ok = (text: string, data?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(data ? { structuredContent: data } : {}),
});
export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function resolveInput(p: string): string {
  let expanded = p.trim();
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = path.join(os.homedir(), expanded.slice(1));
  // "C:" alone means the current folder on that drive in Windows. Treat it as the drive root.
  if (/^[a-zA-Z]:$/.test(expanded)) expanded += path.sep;
  return path.resolve(expanded);
}

export function noScanMessage(abs: string): ToolResult {
  const running = registry.list().find((j) => j.status === "running" && isWithin(j.root, abs));
  if (running) {
    return fail(`A scan of ${running.root} is still running (${running.filesSeen.toLocaleString()} files so far). Call scan_folder with that path to wait for it, then try again.`);
  }
  return fail(`No finished scan covers ${abs}. Call scan_folder with this path (or a parent folder) first.`);
}


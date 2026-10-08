// Regenerates the tool reference in README.md and docs/index.html from the real tool definitions.
// Run `npm run docs` after changing anything in src/tools.ts. CI runs `npm run docs:check`.
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { tools } from "../dist/src/tools.js";
import { TOP_FILES_LIMIT } from "../dist/src/scanner.js";

const check = process.argv.includes("--check");

function describeType(schema) {
  if (schema.type === "array") return `${describeType(schema.items ?? {})}[]`;
  return schema.type ?? "any";
}

function paramRows(def) {
  const json = z.toJSONSchema(z.object(def.inputSchema), { io: "input" });
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    type: describeType(s),
    required: required.has(name),
    def: s.default,
    description: s.description ?? "",
  }));
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const kind = (t) => (t.destructive ? "Changes files" : "Read only");

function markdown() {
  const out = [];
  out.push("| Tool | What it does | Changes files |", "|---|---|---|");
  for (const t of tools) out.push(`| [\`${t.name}\`](#${t.name}) | ${t.title} | ${t.destructive ? "Yes, dry run by default" : "No"} |`);
  out.push("");
  for (const t of tools) {
    out.push(`### \`${t.name}\``, "", t.description, "");
    const rows = paramRows(t);
    if (!rows.length) out.push("No parameters.", "");
    else {
      out.push("| Parameter | Type | Default | Description |", "|---|---|---|---|");
      for (const r of rows) {
        const def = r.def !== undefined ? `\`${JSON.stringify(r.def)}\`` : r.required ? "required" : "optional";
        out.push(`| \`${r.name}\` | ${r.type} | ${def} | ${r.description.replace(/\|/g, "\\|")} |`);
      }
      out.push("");
    }
  }
  return out.join("\n").trimEnd();
}

function html() {
  const out = [];
  for (const t of tools) {
    const rows = paramRows(t);
    out.push(`<article class="tool" id="tool-${t.name}">`);
    out.push(`  <header><h3><code>${t.name}</code></h3><span class="tag ${t.destructive ? "tag-warn" : "tag-ok"}">${kind(t)}</span></header>`);
    out.push(`  <p>${esc(t.description)}</p>`);
    if (rows.length) {
      out.push("  <dl class=\"params\">");
      for (const r of rows) {
        const def = r.def !== undefined ? ` <span class="def">default ${esc(JSON.stringify(r.def))}</span>` : r.required ? ' <span class="def">required</span>' : ' <span class="def">optional</span>';
        out.push(`    <dt><code>${r.name}</code> <span class="type">${esc(r.type)}</span>${def}</dt><dd>${esc(r.description)}</dd>`);
      }
      out.push("  </dl>");
    }
    out.push("</article>");
  }
  return out.join("\n");
}

const jobs = [
  ["README.md", "tools", markdown()],
  ["README.md", "tool-count", String(tools.length)],
  ["docs/index.html", "tools", html()],
  ["docs/index.html", "tool-count", String(tools.length)],
  ["README.md", "top-files", String(TOP_FILES_LIMIT)],
];
const INLINE = new Set(["tool-count", "top-files"]);

let drift = false;
const files = new Map();
for (const [file, marker, content] of jobs) {
  const current = files.get(file) ?? readFileSync(file, "utf8");
  const re = new RegExp(`(<!-- ${marker}:start -->)[\\s\\S]*?(<!-- ${marker}:end -->)`);
  if (!re.test(current)) throw new Error(`Marker ${marker} not found in ${file}`);
  const inline = INLINE.has(marker);
  const next = current.replace(re, (_, a, b) => (inline ? `${a}${content}${b}` : `${a}\n${content}\n${b}`));
  files.set(file, next);
}
for (const [file, next] of files) {
  const current = readFileSync(file, "utf8");
  if (current !== next) {
    drift = true;
    if (!check) writeFileSync(file, next);
  }
}
if (check && drift) {
  console.error("Docs are out of date. Run `npm run docs` and commit the result.");
  process.exit(1);
}
console.log(check ? "Docs are up to date." : drift ? "Docs updated." : "Docs already up to date.");

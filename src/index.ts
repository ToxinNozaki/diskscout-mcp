#!/usr/bin/env node
import "./boot.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { tools } from "./tools.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const VERSION = pkg.version;

const server = new McpServer({ name: "diskscout-mcp", version: VERSION });

for (const t of tools) {
  server.registerTool(
    t.name,
    {
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive, idempotentHint: t.readOnly, openWorldHint: false },
    },
    async (args: unknown) => {
      try {
        return await t.handler(args);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
console.error(`diskscout-mcp ${VERSION} ready on stdio`);

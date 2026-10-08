# Contributing

Thanks for helping. The project is small on purpose, so changes should be too.

## Setup

```bash
git clone https://github.com/ToxinNozaki/diskscout-mcp.git
cd diskscout-mcp
npm install
npm test
```

## Ground rules

1. **Tools live in `src/tools.ts` only.** After changing one, run `npm run docs` and commit the regenerated README and `docs/index.html`. CI fails if you forget.
2. **Anything that changes files must default to a dry run** and must pass through `checkPathAllowed` in `src/guard.ts`. Add a test for every new rule.
3. **No new runtime dependencies** unless there is a strong reason. The server currently needs only the MCP SDK and zod.
4. **Add cleanup targets in `src/targets.ts`** with an honest risk level: `safe` (regenerates silently), `caution` (regenerates but costs time or bandwidth), `review` (user data, never auto cleared), `system` (managed by the OS).
5. Keep the README, the site and the tool descriptions saying the same thing. If a feature changes, update all three in the same pull request.

## Testing on Windows

CI runs on Windows and Linux. The Recycle Bin path uses PowerShell, so if you touch `src/ops.ts` please try it on a real Windows machine with a throwaway file and mention that in the pull request.

## Reporting problems

Open an issue with your OS, Node version, the tool you called and the output. Please do not paste private file paths you would rather keep to yourself.

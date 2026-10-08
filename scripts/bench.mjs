// Compare scan engines on a folder: node scripts/bench.mjs C:\Users\me
import { ScanJob } from "../dist/src/scanner.js";
import { formatBytes } from "../dist/src/format.js";
import "../dist/src/boot.js";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/bench.mjs <folder>");
  process.exit(1);
}
for (const engine of ["node", "auto"]) {
  const job = new ScanJob(target, { engine });
  await job.promise;
  const secs = (job.durationMs / 1000).toFixed(1);
  console.log(`${engine.padEnd(5)} -> engine ${job.engineUsed.padEnd(8)} ${secs.padStart(7)}s  ${job.filesSeen.toLocaleString().padStart(10)} files  ${String(job.filesPerSecond.toLocaleString()).padStart(9)}/s  ${formatBytes(job.tree.size)}${job.engineNote ? "  note: " + job.engineNote : ""}`);
}

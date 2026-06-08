import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const fileCount = Number(process.env.BENCHMARK_VUE_COUNT ?? 10000);
const runs = Number(process.env.BENCHMARK_RUNS ?? 3);
const outputDir = resolve(process.env.BENCHMARK_OUTPUT_DIR ?? "Benchmark/results");
const projects = [
  { label: "local", filter: "benchmark-local-plugin", project: "local-plugin" },
  { label: "official", filter: "benchmark-official-plugin", project: "official-plugin" },
];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function measure(project) {
  const durations = [];

  await run("pnpm", ["--filter", project.filter, "generate", String(fileCount)]);

  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await run("pnpm", ["--filter", project.filter, "build"]);
    durations.push(performance.now() - start);
  }

  return durations;
}

function stats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];

  return {
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: total / durations.length,
    medianMs,
  };
}

function formatMs(value) {
  return `${(value / 1000).toFixed(3)}s`;
}

await mkdir(outputDir, { recursive: true });
await run("pnpm", ["build"]);

const results = [];

for (const project of projects) {
  const durations = await measure(project);
  results.push({ ...project, fileCount, runs, durationsMs: durations, ...stats(durations) });
}

const local = results.find((result) => result.label === "local");
const official = results.find((result) => result.label === "official");
const diffPercent = ((local.avgMs - official.avgMs) / official.avgMs) * 100;
const medianDiffPercent = ((local.medianMs - official.medianMs) / official.medianMs) * 100;
const summary = [
  "## Rspack UnoCSS Plugin Benchmark",
  "",
  `- Vue files: ${fileCount}`,
  `- Runs: ${runs}`,
  "",
  "| plugin | avg | median | min | max |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...results.map((result) => `| ${result.label} | ${formatMs(result.avgMs)} | ${formatMs(result.medianMs)} | ${formatMs(result.minMs)} | ${formatMs(result.maxMs)} |`),
  "",
  `Average delta: ${diffPercent.toFixed(2)}% versus official`,
  `Median delta: ${medianDiffPercent.toFixed(2)}% versus official`,
  "",
].join("\n");

await writeFile(resolve(outputDir, "benchmark-results.json"), `${JSON.stringify({ fileCount, runs, diffPercent, medianDiffPercent, results }, null, 2)}\n`);
await writeFile(resolve(outputDir, "benchmark-summary.md"), summary);
console.log(summary);

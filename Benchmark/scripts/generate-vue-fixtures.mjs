import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(__dirname, "..");
const projectName = process.argv[2];
const fileCount = Number(process.argv[3] ?? process.env.BENCHMARK_VUE_COUNT ?? 10000);
const batchSize = Number(process.env.BENCHMARK_BATCH_SIZE ?? 1000);

if (!projectName) {
  throw new Error("Missing benchmark project name");
}

const projectRoot = resolve(benchmarkRoot, projectName);
const generatedRoot = resolve(projectRoot, "src/generated");
const manifestPath = resolve(projectRoot, "src/generated.ts");
const classGroups = [
  ["flex", "items-center", "justify-between", "gap-4", "rounded-xl", "bg-blue-500", "p-4", "text-white", "shadow-lg"],
  ["grid", "grid-cols-3", "gap-3", "rounded-2xl", "bg-emerald-500", "p-6", "font-semibold", "text-emerald-950"],
  ["relative", "overflow-hidden", "rounded-lg", "border", "border-slate-200", "bg-white", "p-5", "text-slate-900"],
  ["mx-auto", "max-w-4xl", "rounded-3xl", "bg-violet-600", "px-8", "py-6", "text-violet-50", "ring-4", "ring-violet-200"],
  ["inline-flex", "h-10", "items-center", "rounded-full", "bg-amber-300", "px-5", "text-sm", "font-medium", "text-amber-950"],
];

await rm(generatedRoot, { recursive: true, force: true });
await mkdir(generatedRoot, { recursive: true });

const imports = [];
const exports = [];

for (let start = 0; start < fileCount; start += batchSize) {
  const tasks = [];
  const end = Math.min(start + batchSize, fileCount);

  for (let index = start; index < end; index += 1) {
    const id = String(index).padStart(6, "0");
    const componentName = `Generated${id}`;
    const fileName = `${componentName}.vue`;
    const classes = classGroups[index % classGroups.length].join(" ");
    const content = `<template>\n  <section class="${classes}">\n    <span class="text-xs uppercase tracking-widest opacity-70">benchmark</span>\n    <strong class="text-2xl font-bold">${componentName}</strong>\n    <p class="mt-2 leading-7">Rspack UnoCSS benchmark fixture ${index}</p>\n  </section>\n</template>\n`;

    imports.push(`import ${componentName} from "./generated/${fileName}";`);
    exports.push(componentName);
    tasks.push(writeFile(resolve(generatedRoot, fileName), content));
  }

  await Promise.all(tasks);
}

await writeFile(manifestPath, `${imports.join("\n")}\n\nexport const generatedModules = [${exports.join(", ")}];\n`);
console.log(`Generated ${fileCount} Vue files for ${projectName}`);

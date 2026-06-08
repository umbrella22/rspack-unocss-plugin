import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "@unocss/config";
import fg from "fast-glob";
import picomatch from "picomatch";
import { createGenerator, type UnoGenerator } from "unocss";
import { applyTransformers, type TransformResult } from "./transformers.js";
import type { ResolvedUnoCSSRspackNativePluginOptions } from "./types.js";
import { isVirtualUnoPath, LAYER_MARK_ALL } from "./virtual.js";

/**
 * Minimal structural view of a UnoCSS generate result, decoupled from the
 * overloaded `generate` signature so the public context type stays stable.
 */
export interface GeneratedCss {
  readonly css: string;
  getLayer(name?: string): string | undefined;
  getLayers(includes?: string[], excludes?: string[]): string;
}

export interface UnoCSSNativeContext {
  readonly uno: UnoGenerator;
  /** Resolves once the initial config load has finished. */
  readonly ready: Promise<void>;
  /** Resolved config file paths, registered as watch dependencies. */
  readonly configFiles: Set<string>;
  /** Files matched by `content.filesystem`, registered as watch dependencies. */
  readonly filesystemFiles: Set<string>;
  /** Ids of source modules that have contributed tokens. */
  readonly moduleIds: Set<string>;
  /** Cumulative timings, populated only when profiling is enabled. */
  readonly profile: UnoProfile;
  reloadConfig(): Promise<void>;
  shouldExtract(file: string): boolean;
  transformModule(code: string, id: string): Promise<TransformResult>;
  /** Drops a module's cached code and tokens (e.g. when its file is deleted). */
  removeModule(id: string): void;
  extractExternalContent(): Promise<void>;
  generate(): Promise<GeneratedCss>;
}

/**
 * Cumulative wall-clock spent in each phase of the pipeline, used to decide
 * whether moving extraction off the main thread (A2) is worthwhile. `transform`
 * is generator-dependent; `extract` is the candidate-token scan that could run
 * in a worker; `generate` is the inherently main-thread CSS build.
 */
export interface UnoProfile {
  enabled: boolean;
  transformMs: number;
  extractMs: number;
  generateMs: number;
  transformCount: number;
  extractCount: number;
  generateCount: number;
  /** Times `generate()` reused the cached result instead of re-running. */
  generateSkipped: number;
}

const profilingEnabled = Boolean(process.env.UNOCSS_RSPACK_PROFILE);

const defaultExtensions = [
  "vue",
  "svelte",
  "astro",
  "jsx",
  "tsx",
  "js",
  "ts",
  "mjs",
  "cjs",
  "html",
  "md",
  "mdx",
];

export function createUnoCSSNativeContext(
  options: ResolvedUnoCSSRspackNativePluginOptions,
): UnoCSSNativeContext {
  // Assigned synchronously below via `reloadConfig()`; every async accessor
  // awaits `ready` before touching it.
  let uno!: UnoGenerator;
  let configFiles = new Set<string>();
  const sourceFilter = createSourceFilter(options);
  const filesystemFiles = new Set<string>();
  // Per-module caches keep extraction fine-grained: only modules whose source
  // actually changed are re-run by the loader, and tokens are recomputed as the
  // union of every module's set, so removed classes do not linger. `removeModule`
  // evicts both maps when a file leaves the graph so its tokens stop appearing.
  const moduleCode = new Map<string, string>();
  const moduleTokens = new Map<string, Set<string>>();
  // Tokens extracted from `content.inline` / `content.filesystem`. Kept separate
  // from module tokens so a watch rebuild can refresh them without re-reading
  // every filesystem file on every compilation.
  const externalTokens = new Map<string, Set<string>>();
  let externalExtracted = false;

  const profile: UnoProfile = {
    enabled: profilingEnabled,
    transformMs: 0,
    extractMs: 0,
    generateMs: 0,
    transformCount: 0,
    extractCount: 0,
    generateCount: 0,
    generateSkipped: 0,
  };

  // Cache for `generate()`: a changed config bumps `configVersion`, and the
  // token-union hash captures every class that would feed the generator. When
  // both match the last run, the produced CSS is identical, so the cached
  // result is reused and the (~24% of build time) generate pass is skipped.
  let configVersion = 0;
  let lastGenerateKey: string | undefined;
  let lastGenerateResult: GeneratedCss | undefined;

  async function reloadConfig() {
    uno = await createUnoGenerator(options);
    configFiles = await resolveConfigFiles(options);
    // Re-extract every cached module with the new generator so config changes
    // do not require the whole graph to be rebuilt.
    for (const [id, code] of moduleCode) {
      moduleTokens.set(id, await extractTokens(uno, code, id));
    }
    // External content is generator-dependent too; force a refresh on next pass.
    externalExtracted = false;
    // A new generator can map identical tokens to different CSS, so invalidate
    // the generate cache regardless of whether the token union changed.
    configVersion += 1;
  }

  async function transformModule(
    code: string,
    id: string,
  ): Promise<TransformResult> {
    await ready;
    const t0 = profile.enabled ? performance.now() : 0;
    const result = await applyTransformers(code, id, {
      uno,
      tokens: moduleTokens.get(id) ?? new Set<string>(),
    });
    if (profile.enabled) {
      profile.transformMs += performance.now() - t0;
      profile.transformCount += 1;
    }
    moduleCode.set(id, result.code);

    const e0 = profile.enabled ? performance.now() : 0;
    moduleTokens.set(id, await extractTokens(uno, result.code, id));
    if (profile.enabled) {
      profile.extractMs += performance.now() - e0;
      profile.extractCount += 1;
    }
    return result;
  }

  function removeModule(id: string) {
    moduleCode.delete(id);
    moduleTokens.delete(id);
  }

  async function extractExternalContent() {
    await ready;
    // `content.inline` / `content.filesystem` do not change between watch
    // rebuilds, so extract them once. `reloadConfig` resets the flag because a
    // new generator (and possibly new content config) requires a fresh pass.
    if (externalExtracted) return;
    externalExtracted = true;

    const inline = uno.config.content?.inline ?? [];
    for (let index = 0; index < inline.length; index += 1) {
      const entry = inline[index];
      const resolved = typeof entry === "function" ? await entry() : entry;
      const code = typeof resolved === "string" ? resolved : resolved.code;
      const id =
        typeof resolved === "string"
          ? `__inline_${index}__`
          : (resolved.id ?? `__inline_${index}__`);
      const transformed = await applyTransformers(code, id, {
        uno,
        tokens: new Set<string>(),
      });
      externalTokens.set(id, await extractTokens(uno, transformed.code, id));
    }

    const patterns = uno.config.content?.filesystem ?? [];
    if (patterns.length === 0) return;

    const files = await fg(patterns, {
      cwd: options.root,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    for (const file of files) {
      filesystemFiles.add(file);
      const code = await fs.readFile(file, "utf8");
      const transformed = await applyTransformers(code, file, {
        uno,
        tokens: new Set<string>(),
      });
      externalTokens.set(file, await extractTokens(uno, transformed.code, file));
    }
  }

  async function generate() {
    await ready;
    const tokens = new Set<string>();
    for (const set of moduleTokens.values()) {
      for (const token of set) tokens.add(token);
    }
    for (const set of externalTokens.values()) {
      for (const token of set) tokens.add(token);
    }

    // Reuse the previous result when neither the config nor the token union
    // changed: identical inputs to `uno.generate` yield identical CSS. Hashing a
    // sorted token list costs ~1ms against a ~hundreds-of-ms generate pass.
    const key = `${configVersion}:${hashTokens(tokens)}`;
    if (key === lastGenerateKey && lastGenerateResult) {
      if (profile.enabled) profile.generateSkipped += 1;
      return lastGenerateResult;
    }

    const g0 = profile.enabled ? performance.now() : 0;
    const result = await uno.generate(tokens, { minify: options.minify });
    if (profile.enabled) {
      profile.generateMs += performance.now() - g0;
      profile.generateCount += 1;
    }
    lastGenerateKey = key;
    lastGenerateResult = result;
    return result;
  }

  const ready = reloadConfig();

  return {
    get uno() {
      return uno;
    },
    ready,
    get configFiles() {
      return configFiles;
    },
    filesystemFiles,
    get moduleIds() {
      return new Set(moduleCode.keys());
    },
    profile,
    reloadConfig,
    shouldExtract: sourceFilter,
    transformModule,
    removeModule,
    extractExternalContent,
    generate,
  };
}

async function extractTokens(uno: UnoGenerator, code: string, id: string) {
  const set = new Set<string>();
  await uno.applyExtractors(code, id, set);
  return set;
}

/**
 * Order-independent fingerprint of a token set. Sorting makes the hash depend
 * only on which classes are present, not on module extraction order, so an
 * unrelated rebuild that produces the same classes hits the generate cache.
 */
function hashTokens(tokens: Set<string>) {
  const sorted = Array.from(tokens).sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export { LAYER_MARK_ALL };

async function createUnoGenerator(
  options: ResolvedUnoCSSRspackNativePluginOptions,
) {
  if (typeof options.configOrPath === "object") {
    return createGenerator(options.configOrPath, options.defaults);
  }

  const result = await loadConfig(
    options.root,
    options.configOrPath,
    undefined,
    options.defaults,
  );
  return createGenerator(result.config, options.defaults);
}

async function resolveConfigFiles(
  options: ResolvedUnoCSSRspackNativePluginOptions,
) {
  if (typeof options.configOrPath === "string") {
    return new Set([path.resolve(options.root, options.configOrPath)]);
  }

  const matches = await fg(
    [
      "unocss.config.{js,mjs,cjs,ts,mts,cts}",
      "uno.config.{js,mjs,cjs,ts,mts,cts}",
    ],
    {
      cwd: options.root,
      absolute: true,
      onlyFiles: true,
    },
  );

  return new Set(matches);
}

/**
 * Builds the predicate that decides whether a given file should be scanned for
 * UnoCSS tokens. Shared by the loader rule (`test`) and the context so the
 * matching logic stays in one place.
 */
export function createSourceFilter(
  options: ResolvedUnoCSSRspackNativePluginOptions,
): (file: string) => boolean {
  const includeMatcher = createIncludeMatcher(options);
  return (file) => {
    if (isVirtualUnoPath(file)) return false;
    if (matchesExclude(file, options.exclude)) return false;
    if (options.include.length > 0) return includeMatcher(file);
    return hasDefaultExtension(file);
  };
}

function createIncludeMatcher(
  options: ResolvedUnoCSSRspackNativePluginOptions,
): (file: string) => boolean {
  const regexes = options.include.filter(
    (item): item is RegExp => item instanceof RegExp,
  );
  const globs = options.include.filter(
    (item): item is string => typeof item === "string",
  );
  const isGlobMatch =
    globs.length > 0 ? picomatch(globs, { dot: true }) : undefined;

  return (file) => {
    const relative = toPosix(path.relative(options.root, file));
    if (regexes.some((item) => item.test(file) || item.test(relative))) {
      return true;
    }
    return isGlobMatch ? isGlobMatch(relative) || isGlobMatch(file) : false;
  };
}

function matchesExclude(
  file: string,
  exclude: ResolvedUnoCSSRspackNativePluginOptions["exclude"],
) {
  return exclude.some((item) =>
    typeof item === "string" ? file.includes(item) : item.test(file),
  );
}

function hasDefaultExtension(file: string) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return defaultExtensions.includes(ext);
}

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

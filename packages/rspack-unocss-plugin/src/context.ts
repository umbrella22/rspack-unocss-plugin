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
  /**
   * Drops every cached module whose path is not in `current`. Used each watch
   * rebuild to evict modules that left the graph without being deleted on disk
   * (e.g. an import was removed), so their tokens stop feeding `generate()` and
   * the per-module caches do not grow without bound.
   */
  evictModulesNotIn(current: Set<string>): void;
  extractExternalContent(): Promise<void>;
  /**
   * Marks the external (`content.inline` / `content.filesystem`) extraction as
   * stale so the next `extractExternalContent()` re-runs from scratch. Called
   * when a watched filesystem content file changes — the one-shot guard alone
   * would otherwise keep serving stale tokens until a config reload.
   */
  invalidateExternalContent(): void;
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
  // `moduleSources` keeps the loader-supplied (pre-transform) source so that a
  // config reload can re-run the transformer pipeline against the original code
  // — `moduleCode` alone only holds the post-transform output.
  const moduleSources = new Map<string, string>();
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

  async function doReloadConfig() {
    // Resolve config file paths before creating the generator. Generator
    // creation is the step most likely to throw on a broken initial config
    // (syntax error, missing preset, bad `configOrPath`). Resolving paths first
    // guarantees they are registered as watch dependencies even on failure, so
    // the user can fix the config and the watcher re-triggers a reload instead
    // of the plugin getting permanently stuck with an empty `configFiles`.
    const globConfigFiles = await resolveConfigFiles(options);
    // Set config files from the glob immediately so they are registered as
    // watch dependencies even if generator creation fails below (broken config,
    // missing preset, etc.). The original design guarantees `configFiles` is
    // populated before the potentially-throwing `createUnoGenerator` call so
    // the watcher can retrigger a reload once the user fixes the config.
    configFiles = globConfigFiles;
    const { generator, sources } = await createUnoGenerator(options);
    // Merge in config files discovered by @unocss/config's `loadConfig`, which
    // walks up the directory tree and may find configs in a parent monorepo
    // directory that the root-scoped glob would miss.
    if (sources.length > 0) {
      configFiles = new Set([...globConfigFiles, ...sources]);
    }
    // Bump the version AFTER swapping the generator. Bumping before risks
    // leaving a stale cache key if generator creation throws: `configVersion`
    // would be incremented but `uno` would still be the old generator, and the
    // next `generate()` would compute a fresh key but with the old `uno`
    // (wasted work) while the old cached result would never be hit again.
    configVersion += 1;
    uno = generator;
    // Mark external content stale before the re-transform loop: a new generator
    // changes how it is extracted, and if the loop throws partway the next pass
    // must still re-extract against the new generator rather than reusing the
    // previous one's external tokens.
    externalExtracted = false;
    // Re-run the full transformer pipeline against each module's original source
    // so transformer/rule changes take effect without a full graph rebuild.
    // `moduleCode` only holds post-transform output, which is not re-transformable,
    // so this relies on `moduleSources`. `transformModuleInner` is used instead of
    // `transformModule` because the latter `await`s `ready` — the very promise this
    // reload fulfils — which would otherwise deadlock.
    for (const id of [...moduleSources.keys()]) {
      await transformModuleInner(moduleSources.get(id)!, id);
    }
  }

  // In-flight guard: `reloadConfig` may be called while a previous reload is
  // still in progress (e.g. rapid saves, programmatic API).  Serialising
  // through a single chain prevents interleaved mutations of `uno`,
  // `configVersion`, `configFiles`, and the per-module caches.
  let _reloadChain: Promise<void> = Promise.resolve();

  function reloadConfig(): Promise<void> {
    // Each reload attempt becomes the new `ready`. A failed initial load (e.g.
    // a broken config) no longer permanently rejects `ready`: once the user
    // fixes the config the watcher re-triggers `reloadConfig`, and a successful
    // run replaces `ready` with a resolved promise so downstream hooks recover
    // instead of staying rejected forever.
    const promise = _reloadChain.then(() => doReloadConfig());
    _reloadChain = promise.catch(() => {});
    readyPromise = promise;
    return promise;
  }

  async function transformModule(
    code: string,
    id: string,
  ): Promise<TransformResult> {
    await readyPromise;
    return transformModuleInner(code, id);
  }

  /**
   * Transform + extract core, assuming `uno` and the config are already loaded.
   * Split out so `reloadConfig` can re-run the pipeline against cached sources
   * without `await`ing `ready` (which is the promise `reloadConfig` itself
   * resolves, so awaiting it here would deadlock).
   */
  async function transformModuleInner(
    code: string,
    id: string,
  ): Promise<TransformResult> {
    const t0 = profile.enabled ? performance.now() : 0;
    // Fresh token set per transform, shared between the transformer context and
    // the extractor. Transformers may `add` classes they infer without writing
    // them into the code (the UnoCSS `context.tokens` contract); extracting into
    // the same set merges those with classes found in the transformed code.
    // Reusing the previous module's set would let dropped classes linger.
    const tokens = new Set<string>();
    const result = await applyTransformers(code, id, { uno, tokens });
    if (profile.enabled) {
      profile.transformMs += performance.now() - t0;
      profile.transformCount += 1;
    }
    moduleSources.set(id, code);
    moduleCode.set(id, result.code);

    const e0 = profile.enabled ? performance.now() : 0;
    moduleTokens.set(id, await extractTokens(uno, result.code, id, tokens));
    if (profile.enabled) {
      profile.extractMs += performance.now() - e0;
      profile.extractCount += 1;
    }
    return result;
  }

  function removeModule(id: string) {
    moduleSources.delete(id);
    moduleCode.delete(id);
    moduleTokens.delete(id);
  }

  /**
   * Drops every cached module that is no longer in the current module graph.
   * `removeModule` only handles files reported as removed from disk, but a
   * module can leave the graph while its file still exists (an import was
   * removed, a route deleted, a component retired). Without this diff those
   * modules' tokens would linger in the generate() union and the per-module
   * caches would grow without bound across a long watch session.
   */
  function evictModulesNotIn(current: Set<string>) {
    for (const id of [...moduleCode.keys()]) {
      if (!current.has(id)) {
        moduleSources.delete(id);
        moduleCode.delete(id);
        moduleTokens.delete(id);
      }
    }
  }

  async function extractExternalContent() {
    await readyPromise;
    // `content.inline` / `content.filesystem` are re-extracted only when stale:
    // initially, after `reloadConfig`, or after `invalidateExternalContent`
    // (a watched filesystem content file changed).
    if (externalExtracted) return;
    externalExtracted = true;

    // Extract into pending collections first, then commit atomically. If any
    // entry throws (a failing `content.inline` function, or a filesystem file
    // deleted between glob and read in watch mode), the previously-good tokens
    // and watch dependencies stay in place — so the generated CSS degrades to
    // the last known-good state instead of being wiped, and filesystem content
    // files keep being watched. The guard is reset so the next compilation
    // retries from scratch.
    const pendingTokens = new Map<string, Set<string>>();
    const pendingFiles = new Set<string>();
    try {
      const inline = uno.config.content?.inline ?? [];
      for (let index = 0; index < inline.length; index += 1) {
        const entry = inline[index];
        const resolved = typeof entry === "function" ? await entry() : entry;
        const code = typeof resolved === "string" ? resolved : resolved.code;
        const id =
          typeof resolved === "string"
            ? `__inline_${index}__`
            : (resolved.id ?? `__inline_${index}__`);
        const extTokens = new Set<string>();
        const transformed = await applyTransformers(code, id, {
          uno,
          tokens: extTokens,
        });
        pendingTokens.set(
          id,
          await extractTokens(uno, transformed.code, id, extTokens),
        );
      }

      const patterns = uno.config.content?.filesystem ?? [];
      if (patterns.length > 0) {
        const files = await fg(patterns, {
          cwd: options.root,
          absolute: true,
          onlyFiles: true,
          ignore: ["**/node_modules/**", "**/.git/**"],
        });
        for (const file of files) {
          pendingFiles.add(file);
          const code = await fs.readFile(file, "utf8");
          const extTokens = new Set<string>();
          const transformed = await applyTransformers(code, file, {
            uno,
            tokens: extTokens,
          });
          pendingTokens.set(
            file,
            await extractTokens(uno, transformed.code, file, extTokens),
          );
        }
      }
    } catch (error) {
      externalExtracted = false;
      throw error;
    }

    // Commit only after a fully successful pass. This rebuilds both
    // collections from scratch (a shrunken glob/inline list drops entries that
    // are no longer present) without ever exposing an empty intermediate state.
    externalTokens.clear();
    for (const [id, tokens] of pendingTokens) externalTokens.set(id, tokens);
    filesystemFiles.clear();
    for (const file of pendingFiles) filesystemFiles.add(file);
  }

  function invalidateExternalContent() {
    externalExtracted = false;
  }

  async function generate() {
    await readyPromise;
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

  // Declared separately from its first assignment so `reloadConfig` (which
  // reassigns it on every call) can write the field without hitting the temporal
  // dead zone of a single `let x = reloadConfig()` initializer.
  let readyPromise: Promise<void>;
  readyPromise = reloadConfig();

  return {
    get uno() {
      return uno;
    },
    get ready() {
      return readyPromise;
    },
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
    evictModulesNotIn,
    extractExternalContent,
    invalidateExternalContent,
    generate,
  };
}

async function extractTokens(
  uno: UnoGenerator,
  code: string,
  id: string,
  into: Set<string> = new Set<string>(),
) {
  // Extract into the provided set so callers can merge transformer-added tokens
  // (handed to the transformer context) with extractor-found tokens in one set.
  await uno.applyExtractors(code, id, into);
  return into;
}

/**
 * Order-independent fingerprint of a token set. Sorting makes the hash depend
 * only on which classes are present, not on module extraction order, so an
 * unrelated rebuild that produces the same classes hits the generate cache.
 * Each token is length-prefixed so a token containing a newline (or any other
 * delimiter) can't be confused with two adjacent tokens — e.g. without the
 * prefix `"a\nb"` and `["a","b"]` would produce the same `join` and collide.
 */
function hashTokens(tokens: Set<string>) {
  const sorted = Array.from(tokens).sort();
  const fingerprint = sorted
    .map((token) => `${token.length}:${token}`)
    .join("");
  return createHash("sha256").update(fingerprint).digest("hex");
}

export { LAYER_MARK_ALL };

async function createUnoGenerator(
  options: ResolvedUnoCSSRspackNativePluginOptions,
): Promise<{ generator: UnoGenerator; sources: string[] }> {
  if (typeof options.configOrPath === "object") {
    // `createGenerator` returns a Promise in unocss >= 66; await it so the
    // returned `generator` field holds the resolved UnoGenerator, not a
    // pending Promise whose `.config` would be undefined.
    return {
      generator: await createGenerator(options.configOrPath, options.defaults),
      sources: [],
    };
  }

  const result = await loadConfig(
    options.root,
    options.configOrPath,
    undefined,
    options.defaults,
  );
  // `loadConfig` walks up the directory tree and may find config files in a
  // parent directory (common in monorepo setups). `result.sources` contains
  // every config file that contributed, including those outside `options.root`.
  // These must be registered as watch dependencies so edits trigger a reload.
  return {
    generator: await createGenerator(result.config, options.defaults),
    sources: result.sources,
  };
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
  // `.test()` on a global (/g) regex is stateful — it advances lastIndex,
  // and this filter runs once per module, so a user-supplied /g pattern would
  // drift between modules and misclassify them. Clone without the global flag
  // so matching stays stateless; the user's original regexes are untouched.
  const include = withoutGlobalFlag(options.include);
  const exclude = withoutGlobalFlag(options.exclude);
  const includeMatcher = createIncludeMatcher({ ...options, include });
  return (file) => {
    if (isVirtualUnoPath(file)) return false;
    if (matchesExclude(file, exclude, options.root)) return false;
    if (include.length > 0) return includeMatcher(file);
    return hasDefaultExtension(file);
  };
}

function withoutGlobalFlag(
  patterns: Array<string | RegExp>,
): Array<string | RegExp> {
  return patterns.map((item) =>
    item instanceof RegExp
      ? new RegExp(item.source, item.flags.replace("g", ""))
      : item,
  );
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
  root: string,
) {
  const relative = toPosix(path.relative(root, file));
  for (const item of exclude) {
    if (item instanceof RegExp) {
      // Test against both the absolute and the relative path, consistent with
      // `createIncludeMatcher`. A user-supplied regex like `/^src\/legacy\//`
      // matches the relative form and would be silently ignored if only the
      // absolute path were tested.
      if (item.test(file) || item.test(relative)) return true;
    } else {
      // String exclude patterns use picomatch glob matching, consistent with
      // `include`.  The glob is tested against both the absolute path and the
      // path relative to `root`, so patterns like `"**/node_modules/**"` and
      // `"/abs/path/to/file"` both work.
      if (
        picomatch.isMatch(file, item, { dot: true }) ||
        picomatch.isMatch(relative, item, { dot: true })
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasDefaultExtension(file: string) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return defaultExtensions.includes(ext);
}

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

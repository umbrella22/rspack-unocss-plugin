import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  Compilation,
  rspack,
  sources,
  type Compiler,
  type RspackPluginInstance,
} from "@rspack/core";
import {
  createSourceFilter,
  createUnoCSSNativeContext,
  type UnoCSSNativeContext,
} from "./context.js";
import {
  createContextId,
  registerContext,
  unregisterContext,
} from "./registry.js";
import type {
  ResolvedUnoCSSRspackNativePluginOptions,
  UnoCSSRspackNativePluginOptions,
} from "./types.js";
import {
  getLayerPlaceholder,
  getUnoCssLayer,
  getVirtualModuleContent,
  getVirtualPath,
  HASH_PLACEHOLDER_RE,
  isUnoCssId,
  LAYER_MARK_ALL,
  LAYER_PLACEHOLDER_RE,
} from "./virtual.js";

export type { UnoCSSRspackNativePluginOptions } from "./types.js";

type GenerateResult = Awaited<ReturnType<UnoCSSNativeContext["generate"]>>;

const loaderPath = fileURLToPath(new URL("./loader.mjs", import.meta.url));
const initialLayers = ["preflights", "default", "shortcuts", "utilities"];
const UNO_REQUEST_RE = /^(?:virtual:)?uno(?::.+)?\.css(?:\?.*)?$/;

interface VirtualCssModule {
  path: string;
  layer: string;
}

export class UnoCSSRspackNativePlugin implements RspackPluginInstance {
  name = "UnoCSSRspackNativePlugin";
  private readonly options: UnoCSSRspackNativePluginOptions;

  constructor(options: UnoCSSRspackNativePluginOptions = {}) {
    this.options = options;
  }

  apply(compiler: Compiler) {
    const options = resolveOptions(
      this.options,
      compiler.context,
      compiler.options.mode === "production",
    );
    const unoId = createContextId();
    const context = createUnoCSSNativeContext(options);
    registerContext(unoId, context);

    // Maps every virtual CSS path to the layer it represents. Seeded with the
    // main `uno.css` module plus the common layers, then grown on demand when a
    // `uno:<layer>.css` request for an unknown layer is encountered.
    const pathLayers = new Map<string, string>(
      createVirtualCssModules(options).map((item) => [item.path, item.layer]),
    );
    const virtualModules = new rspack.experiments.VirtualModulesPlugin(
      Object.fromEntries(
        Array.from(pathLayers, ([path, layer]) => [
          path,
          getLayerPlaceholder(layer),
        ]),
      ),
    );

    virtualModules.apply(compiler);
    replaceUnoRequests(compiler, options, virtualModules, pathLayers);

    // Inject the fallback CSS rule before the loader rule so the loader's
    // function-based `test` does not confuse the existing-CSS-rule detection.
    if (options.autoCssRule) {
      injectCssRule(compiler, options);
    }

    injectLoaderRule(compiler, options, unoId);

    warnIfCssExperimentDisabled(compiler);

    const lastHash = new Map<string, string>();

    compiler.hooks.watchRun.tapPromise(this.name, async (watchCompiler) => {
      // Evict tokens of files that left the graph so deleted classes do not
      // linger in the union taken by `generate()`.
      const removed = watchCompiler.removedFiles;
      if (removed) {
        for (const file of removed) context.removeModule(file);
      }

      const modified = watchCompiler.modifiedFiles;
      if (!modified) return;
      for (const file of context.configFiles) {
        if (modified.has(file)) {
          await context.reloadConfig();
          break;
        }
      }
    });

    compiler.hooks.thisCompilation.tap(this.name, (compilation) => {
      if (options.watch) {
        compilation.hooks.finishModules.tapPromise(this.name, async () => {
          for (const file of context.configFiles)
            compilation.fileDependencies.add(file);
          for (const file of context.filesystemFiles)
            compilation.fileDependencies.add(file);
        });
      }

      compilation.hooks.processAssets.tapPromise(
        {
          name: this.name,
          stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
        },
        async () => {
          await context.ready;
          try {
            await context.extractExternalContent();
          } catch (error) {
            // A failing `content.inline` function or unreadable `filesystem`
            // file should degrade gracefully, not abort the whole build.
            compiler
              .getInfrastructureLogger(this.name)
              .warn(
                `Failed to extract external UnoCSS content: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
          }
          const result = await context.generate();

          for (const asset of compilation.getAssets()) {
            if (!asset.name.endsWith(".css")) continue;
            const original = asset.source.source().toString();
            if (!original.includes("#unocss-")) continue;
            const replaced = replacePlaceholders(original, result);
            if (replaced !== original) {
              compilation.updateAsset(
                asset.name,
                new sources.RawSource(replaced),
              );
            }
          }

          // In watch mode, refresh each virtual module's hash placeholder so a
          // changed layer alters the chunk hash and HMR re-emits the asset.
          if (!compiler.watchMode) return;
          for (const [virtualPath, layer] of pathLayers) {
            const css = getLayerCss(result, layer);
            const hash = getHash(css);
            if (lastHash.get(virtualPath) === hash) continue;
            lastHash.set(virtualPath, hash);
            virtualModules.writeModule(
              virtualPath,
              getVirtualModuleContent(layer, hash),
            );
          }
        },
      );
    });

    const shutdown = (
      compiler.hooks as {
        shutdown?: { tap(name: string, fn: () => void): void };
      }
    ).shutdown;
    shutdown?.tap(this.name, () => unregisterContext(unoId));

    if (context.profile.enabled) {
      reportProfileOnDone(compiler, context, this.name);
    }
  }
}

/**
 * Prints the cumulative UnoCSS pipeline timings against the total build time at
 * the end of each compilation. Enabled by `UNOCSS_RSPACK_PROFILE`; lets us see
 * what share of the build the loader-side work (transform + extract) actually
 * occupies before deciding whether to move extraction off the main thread.
 */
function reportProfileOnDone(
  compiler: Compiler,
  context: UnoCSSNativeContext,
  name: string,
) {
  let buildStart = performance.now();
  compiler.hooks.compile.tap(name, () => {
    buildStart = performance.now();
  });

  compiler.hooks.done.tap(name, (stats) => {
    const totalMs = performance.now() - buildStart;
    const p = context.profile;
    const loaderMs = p.transformMs + p.extractMs;
    const pct = (value: number) =>
      totalMs > 0 ? `${((value / totalMs) * 100).toFixed(1)}%` : "n/a";
    const logger = compiler.getInfrastructureLogger(name);
    logger.info(
      [
        "UnoCSS profile (cumulative):",
        `  total build      ${totalMs.toFixed(0)}ms`,
        `  transform        ${p.transformMs.toFixed(0)}ms (${pct(p.transformMs)}, ${p.transformCount} modules)`,
        `  extract          ${p.extractMs.toFixed(0)}ms (${pct(p.extractMs)}, ${p.extractCount} modules)`,
        `  loader total     ${loaderMs.toFixed(0)}ms (${pct(loaderMs)}) <- parallelizable (A2)`,
        `  generate         ${p.generateMs.toFixed(0)}ms (${pct(p.generateMs)}, ${p.generateCount} calls, ${p.generateSkipped} cached) <- main-thread only`,
      ].join("\n"),
    );
    // Expose raw numbers so the benchmark harness can read them off stdout.
    if (process.env.UNOCSS_RSPACK_PROFILE === "json") {
      logger.info(
        `UNOCSS_PROFILE_JSON ${JSON.stringify({ totalMs, ...p, statsHash: stats.hash })}`,
      );
    }
  });
}

function resolveOptions(
  options: UnoCSSRspackNativePluginOptions,
  compilerContext: string,
  minify: boolean,
): ResolvedUnoCSSRspackNativePluginOptions {
  const root = path.resolve(options.root ?? compilerContext);

  return {
    configOrPath: options.configOrPath,
    defaults: options.defaults,
    root,
    include: options.include ?? [],
    exclude: options.exclude ?? [/\.css(?:\?.*)?$/, /node_modules/, /\.git/],
    virtualModuleId: options.virtualModuleId ?? "uno.css",
    autoCssRule: options.autoCssRule ?? true,
    lightningcss: options.lightningcss ?? false,
    watch: options.watch ?? true,
    minify,
  };
}

function createVirtualCssModules(
  options: ResolvedUnoCSSRspackNativePluginOptions,
): VirtualCssModule[] {
  return [
    {
      path: getVirtualPath(options.root),
      layer: LAYER_MARK_ALL,
    },
    ...initialLayers.map((layer) => ({
      path: getVirtualPath(options.root, layer),
      layer,
    })),
  ];
}

function replaceUnoRequests(
  compiler: Compiler,
  options: ResolvedUnoCSSRspackNativePluginOptions,
  virtualModules: InstanceType<typeof rspack.experiments.VirtualModulesPlugin>,
  pathLayers: Map<string, string>,
) {
  new rspack.NormalModuleReplacementPlugin(UNO_REQUEST_RE, (data) => {
    const request = data.request;
    if (!isUnoCssId(request)) return;

    const layer = getUnoCssLayer(request);
    const virtualPath = getVirtualPath(options.root, layer);
    const layerName = layer ?? LAYER_MARK_ALL;

    // Register virtual modules for arbitrary layers on first sight so any
    // static `uno:<layer>.css` request resolves without prior discovery.
    if (!pathLayers.has(virtualPath)) {
      pathLayers.set(virtualPath, layerName);
      virtualModules.writeModule(virtualPath, getLayerPlaceholder(layerName));
    }

    data.request = virtualPath;
  }).apply(compiler);
}

function injectLoaderRule(
  compiler: Compiler,
  options: ResolvedUnoCSSRspackNativePluginOptions,
  unoId: string,
) {
  const sourceFilter = createSourceFilter(options);
  const rules = compiler.options.module.rules;
  rules.unshift({
    enforce: "pre",
    test: (resource: string) =>
      typeof resource === "string" && sourceFilter(resource),
    exclude: /node_modules/,
    // Pin to the main thread: extraction relies on the in-process context
    // registry, which a worker thread cannot reach. This stays correct even if
    // Rspack ever defaults loaders to parallel — other loaders (swc, vue) can
    // still opt into `parallel` independently without affecting UnoCSS.
    use: [{ loader: loaderPath, options: { unoId }, parallel: false }],
  });
}

function replacePlaceholders(source: string, result: GenerateResult): string {
  return source
    .replace(HASH_PLACEHOLDER_RE, "")
    .replace(LAYER_PLACEHOLDER_RE, (_match, layer: string) =>
      getLayerCss(result, layer.trim()),
    );
}

function getLayerCss(result: GenerateResult, layer: string): string {
  if (layer === LAYER_MARK_ALL) return result.getLayers() ?? "";
  return result.getLayer(layer) ?? "";
}

function getHash(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function injectCssRule(
  compiler: Compiler,
  options: ResolvedUnoCSSRspackNativePluginOptions,
) {
  const rules = compiler.options.module?.rules;
  if (!rules) return;

  if (rules.some(ruleMatchesCss)) return;

  if (options.lightningcss === false) {
    rules.push({ test: /\.css$/, type: "css/auto" });
    return;
  }

  rules.push({
    test: /\.css$/,
    type: "css/auto",
    use: [
      {
        loader: "builtin:lightningcss-loader",
        options: options.lightningcss === true ? {} : options.lightningcss,
      },
    ],
  });
}

function ruleMatchesCss(rule: unknown): boolean {
  if (!rule || typeof rule !== "object") return false;
  const r = rule as Record<string, unknown>;

  if (Array.isArray(r.oneOf) && r.oneOf.some(ruleMatchesCss)) return true;
  if (Array.isArray(r.rules) && r.rules.some(ruleMatchesCss)) return true;

  const test = r.test;
  if (test instanceof RegExp) return test.test("uno.css");
  if (Array.isArray(test)) return test.some((item) => matchesCssTest(item));
  return matchesCssTest(test);
}

function matchesCssTest(test: unknown): boolean {
  if (test instanceof RegExp) return test.test("uno.css");
  if (typeof test === "string")
    return test.includes(".css") || test.includes("css");
  // A function test cannot be evaluated reliably here; assume it is not a CSS
  // rule so the fallback `css/auto` rule is still injected when needed.
  if (typeof test === "function") return false;
  if (test !== undefined) return true;
  return false;
}

function warnIfCssExperimentDisabled(compiler: Compiler) {
  const experimentsCss = compiler.options.experiments?.css;

  // Explicitly enabled — nothing to warn about.
  if (experimentsCss === true) return;

  // Not explicitly configured: on Rspack >= 2.x native CSS is the default,
  // so the warning is unnecessary.
  if (experimentsCss === undefined) {
    const rspackVersion = getRspackMajorVersion(compiler);
    if (rspackVersion !== null && rspackVersion >= 2) return;
  }

  compiler
    .getInfrastructureLogger("UnoCSSRspackNativePlugin")
    .warn(
      "Rspack native CSS experiment is not enabled. Add `experiments: { css: true }` or provide your own CSS handling rule for `uno.css`.",
    );
}

/**
 * Extracts the Rspack major version from the compiler instance.
 * Returns `null` if the version cannot be determined.
 */
function getRspackMajorVersion(compiler: Compiler): number | null {
  try {
    const version = (
      compiler as Compiler & { webpack?: { rspackVersion?: string } }
    ).webpack?.rspackVersion;
    if (typeof version === "string") {
      const major = Number.parseInt(version, 10);
      return Number.isNaN(major) ? null : major;
    }
    return null;
  } catch {
    return null;
  }
}

export { getUnoCssLayer, getVirtualPath, isUnoCssId };

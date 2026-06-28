import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceCodeTransformer } from "unocss";
import { createUnoCSSNativeContext } from "../src/context.js";
import type { ResolvedUnoCSSRspackNativePluginOptions } from "../src/types.js";

const root = path.join("tmp", "project");

function resolveOptions(
  overrides: Partial<ResolvedUnoCSSRspackNativePluginOptions> = {},
): ResolvedUnoCSSRspackNativePluginOptions {
  return {
    configOrPath: { rules: [["text-red", { color: "red" }]] },
    defaults: undefined,
    root,
    include: [],
    exclude: [/\.css(?:\?.*)?$/, /node_modules/, /\.git/],
    virtualModuleId: "uno.css",
    autoCssRule: true,
    lightningcss: false,
    watch: true,
    minify: false,
    ...overrides,
  };
}

describe("removeModule", () => {
  it("drops a deleted module's tokens from the generated CSS", async () => {
    const context = createUnoCSSNativeContext(resolveOptions());
    await context.ready;

    await context.transformModule(`<div class="text-red"></div>`, "a.vue");
    expect((await context.generate()).css).toContain("color:red");

    context.removeModule("a.vue");
    expect((await context.generate()).css).not.toContain("color:red");
  });
});

describe("generate cache", () => {
  it("reuses the result when the token union is unchanged", async () => {
    const context = createUnoCSSNativeContext(resolveOptions());
    await context.ready;

    await context.transformModule(`<div class="text-red"></div>`, "a.vue");
    const first = await context.generate();
    // Nothing changed between the two calls, so the cached result is returned.
    const second = await context.generate();

    expect(second).toBe(first);
  });

  it("regenerates when a new token appears", async () => {
    const context = createUnoCSSNativeContext(
      resolveOptions({
        configOrPath: {
          rules: [
            ["text-red", { color: "red" }],
            ["font-bold", { "font-weight": "700" }],
          ],
        },
      }),
    );
    await context.ready;

    await context.transformModule(`<div class="text-red"></div>`, "a.vue");
    const first = await context.generate();

    await context.transformModule(
      `<div class="text-red font-bold"></div>`,
      "a.vue",
    );
    const second = await context.generate();

    expect(second).not.toBe(first);
    expect(second.css).toContain("font-weight:700");
  });
});

describe("reloadConfig", () => {
  it("re-runs the transformer pipeline so transformer changes take effect", async () => {
    // A custom transformer that injects a marker class only when `flag.on`.
    // Lets us observe whether reloadConfig re-transformed the cached module
    // without depending on any preset's exact CSS output.
    const flag = { on: false };
    const marker = "injected-mark";
    const transformer: SourceCodeTransformer = {
      name: "toggling",
      enforce: "pre",
      transform(code) {
        if (flag.on) code.append(`<div class="${marker}"></div>`);
      },
    };
    const config = {
      rules: [[marker, { color: "red" }]],
      transformers: [transformer],
    };
    const context = createUnoCSSNativeContext(
      resolveOptions({ configOrPath: config }),
    );
    await context.ready;

    await context.transformModule(`<div class="base"></div>`, "a.vue");
    expect((await context.generate()).css).not.toContain("color:red");

    // Flip the transformer on and reload. The cached module's original source
    // must be re-transformed, otherwise the marker would never be extracted.
    flag.on = true;
    await context.reloadConfig();
    expect((await context.generate()).css).toContain("color:red");
  });

  it("drops external content tokens that disappeared after a reload", async () => {
    const inlineContent: string[] = [`<div class="gone"></div>`];
    const config = {
      rules: [["gone", { color: "red" }]],
      content: { inline: inlineContent },
    };
    const context = createUnoCSSNativeContext(
      resolveOptions({ configOrPath: config }),
    );
    await context.ready;

    await context.extractExternalContent();
    expect((await context.generate()).css).toContain("color:red");

    // Remove the inline content and reload. Without clearing externalTokens,
    // the "gone" token would linger in the generate() union forever.
    inlineContent.length = 0;
    await context.reloadConfig();
    await context.extractExternalContent();
    expect((await context.generate()).css).not.toContain("color:red");
  });

  it("forgets removed modules across a reload", async () => {
    const context = createUnoCSSNativeContext(
      resolveOptions({
        configOrPath: { rules: [["text-red", { color: "red" }]] },
      }),
    );
    await context.ready;

    await context.transformModule(`<div class="text-red"></div>`, "a.vue");
    context.removeModule("a.vue");
    await context.reloadConfig();
    expect((await context.generate()).css).not.toContain("color:red");
  });

  it("still resolves config file paths when the initial generator fails", async () => {
    // A broken initial config (missing file, syntax error, bad preset) makes
    // generator creation reject. `resolveConfigFiles` must still have run first
    // so the config path is registered as a watch dependency and the watcher
    // can retrigger a reload once the user fixes it — otherwise the plugin
    // would be permanently stuck with an empty `configFiles`.
    const context = createUnoCSSNativeContext(
      resolveOptions({ configOrPath: "/nonexistent/unocss.config.ts" }),
    );
    await expect(context.ready).rejects.toThrow();
    expect(context.configFiles.size).toBe(1);
  });

  it("replaces ready with each reload so a failed first load can recover", async () => {
    // `ready` reflects the latest reload rather than a one-shot initial
    // promise, so a failed initial load no longer dooms every downstream hook:
    // a later successful reload swaps in a resolved `ready`.
    const context = createUnoCSSNativeContext(
      resolveOptions({
        configOrPath: { rules: [["text-red", { color: "red" }]] },
      }),
    );
    await context.ready;
    const firstReady = context.ready;

    await context.reloadConfig();
    const secondReady = context.ready;
    expect(secondReady).not.toBe(firstReady);
    await expect(secondReady).resolves.toBeUndefined();
  });
});

describe("transform tokens", () => {
  it("keeps tokens added by a transformer that does not rewrite the code", async () => {
    // Exercises the UnoCSS `context.tokens` contract: a transformer may infer a
    // class and register it via `ctx.tokens.add(...)` without writing it into
    // the source. Previously the extractor ran over a brand-new set, dropping
    // the transformer-added token; now both share the same set.
    const marker = "inferred-class";
    const transformer: SourceCodeTransformer = {
      name: "inferring",
      enforce: "pre",
      transform(_code, _id, ctx) {
        ctx.tokens.add(marker);
      },
    };
    const context = createUnoCSSNativeContext(
      resolveOptions({
        configOrPath: {
          rules: [[marker, { color: "red" }]],
          transformers: [transformer],
        },
      }),
    );
    await context.ready;

    await context.transformModule(`<div class="base"></div>`, "a.vue");
    expect((await context.generate()).css).toContain("color:red");
  });
});

describe("external content", () => {
  it("recovers when extraction fails partway and retries on the next pass", async () => {
    // A `content.inline` entry that throws the first time. Previously the
    // one-shot `externalExtracted` guard was flipped before any await, so the
    // failure permanently froze the context in a half-extracted state. Now the
    // guard is reset on failure so the next compilation retries.
    let shouldFail = true;
    const inlineContent = [
      () =>
        shouldFail
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(`<div class="recovered"></div>`),
    ];
    const config = {
      rules: [["recovered", { color: "red" }]],
      content: { inline: inlineContent },
    };
    const context = createUnoCSSNativeContext(
      resolveOptions({ configOrPath: config }),
    );
    await context.ready;

    await expect(context.extractExternalContent()).rejects.toThrow("boom");
    expect((await context.generate()).css).not.toContain("color:red");

    shouldFail = false;
    await context.extractExternalContent();
    expect((await context.generate()).css).toContain("color:red");
  });

  it("keeps the last good external tokens when a later extraction fails", async () => {
    // Atomic-commit semantics: extraction writes to pending collections and
    // only swaps them in on success. A failing pass must not wipe the
    // previously-good tokens (nor the filesystem watch set), so the generated
    // CSS degrades to the last known-good state instead of going empty.
    let shouldFail = false;
    const config = {
      rules: [["good", { color: "green" }]],
      content: {
        inline: [
          () =>
            shouldFail
              ? Promise.reject(new Error("inline boom"))
              : Promise.resolve(`<div class="good"></div>`),
        ],
      },
    };
    const context = createUnoCSSNativeContext(
      resolveOptions({ configOrPath: config }),
    );
    await context.ready;

    await context.extractExternalContent();
    expect((await context.generate()).css).toContain("color:green");

    shouldFail = true;
    context.invalidateExternalContent();
    await expect(context.extractExternalContent()).rejects.toThrow(
      "inline boom",
    );
    expect((await context.generate()).css).toContain("color:green");
  });
});

describe("module graph eviction", () => {
  it("drops tokens of modules that leave the graph without being deleted", async () => {
    // watchRun's `removedFiles` only covers on-disk deletion. A module that
    // leaves the graph because its import was removed (but the file still
    // exists) must still be evicted, or its tokens linger in the generate()
    // union forever and the per-module caches grow without bound.
    const context = createUnoCSSNativeContext(
      resolveOptions({
        configOrPath: { rules: [["text-red", { color: "red" }]] },
      }),
    );
    await context.ready;

    await context.transformModule(`<div class="text-red"></div>`, "a.vue");
    expect((await context.generate()).css).toContain("color:red");

    // The graph snapshot no longer contains a.vue → evict it.
    context.evictModulesNotIn(new Set());
    expect((await context.generate()).css).not.toContain("color:red");
  });

  it("keeps modules that are still in the graph snapshot", async () => {
    const context = createUnoCSSNativeContext(
      resolveOptions({
        configOrPath: {
          rules: [
            ["text-red", { color: "red" }],
            ["font-bold", { "font-weight": "700" }],
          ],
        },
      }),
    );
    await context.ready;

    await context.transformModule(`<div class="text-red"></div>`, "a.vue");
    await context.transformModule(`<div class="font-bold"></div>`, "b.vue");

    // Only a.vue remains in the graph.
    context.evictModulesNotIn(new Set(["a.vue"]));
    const css = (await context.generate()).css;
    expect(css).toContain("color:red");
    expect(css).not.toContain("font-weight:700");
  });
});

describe("layer dedupe", () => {
  it("getLayers excludes a separately-imported layer from the all-layers set", async () => {
    // `getLayerCss` for the all-layers module calls
    // `result.getLayers(undefined, [...importedLayers])`. This validates that
    // contract: a layer named in `excludes` must not appear, so importing both
    // `uno.css` and `uno:<layer>.css` does not duplicate that layer's CSS.
    const context = createUnoCSSNativeContext(
      resolveOptions({
        configOrPath: {
          rules: [["text-red", { color: "red" }, { layer: "isolated" }]],
        },
      }),
    );
    await context.ready;
    await context.transformModule(`<div class="text-red"></div>`, "a.vue");
    const result = await context.generate();

    expect(result.getLayers()).toContain("color:red");
    expect(result.getLayers(undefined, ["isolated"])).not.toContain(
      "color:red",
    );
  });
});

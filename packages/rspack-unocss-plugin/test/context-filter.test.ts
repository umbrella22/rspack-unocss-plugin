import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSourceFilter,
  createUnoCSSNativeContext,
} from "../src/context.js";
import { getVirtualPath } from "../src/virtual.js";
import type { ResolvedUnoCSSRspackNativePluginOptions } from "../src/types.js";

const root = path.join("tmp", "project");

function resolveOptions(
  overrides: Partial<ResolvedUnoCSSRspackNativePluginOptions> = {},
): ResolvedUnoCSSRspackNativePluginOptions {
  return {
    configOrPath: { presets: [] },
    defaults: undefined,
    root,
    include: [],
    exclude: [/\.css(?:\?.*)?$/, /node_modules/, /\.git/],
    virtualModuleId: "uno.css",
    autoCssRule: true,
    watch: true,
    minify: false,
    ...overrides,
  };
}

describe("createSourceFilter", () => {
  it("accepts default source extensions and rejects others", () => {
    const filter = createSourceFilter(resolveOptions());
    expect(filter(path.join(root, "src", "App.vue"))).toBe(true);
    expect(filter(path.join(root, "src", "main.ts"))).toBe(true);
    expect(filter(path.join(root, "src", "page.html"))).toBe(true);
    expect(filter(path.join(root, "src", "readme.txt"))).toBe(false);
  });

  it("never matches the plugin's own virtual css modules", () => {
    const filter = createSourceFilter(resolveOptions());
    expect(filter(getVirtualPath(root))).toBe(false);
    expect(filter(getVirtualPath(root, "utilities"))).toBe(false);
  });

  it("excludes css and node_modules by default", () => {
    const filter = createSourceFilter(resolveOptions());
    expect(filter(path.join(root, "src", "style.css"))).toBe(false);
    expect(filter(path.join(root, "node_modules", "pkg", "index.ts"))).toBe(
      false,
    );
  });

  it("honors string glob includes", () => {
    const filter = createSourceFilter(
      resolveOptions({ include: ["src/**/*.{vue,ts}"] }),
    );
    expect(filter(path.join(root, "src", "App.vue"))).toBe(true);
    expect(filter(path.join(root, "other", "App.vue"))).toBe(false);
  });

  it("honors regexp includes against absolute and relative paths", () => {
    const filter = createSourceFilter(
      resolveOptions({ include: [/src\/.*\.(vue|ts)$/] }),
    );
    expect(filter(path.join(root, "src", "main.ts"))).toBe(true);
    expect(filter(path.join(root, "lib", "main.ts"))).toBe(false);
  });

  it("keeps matching stateless for user /g include/exclude regexes", () => {
    // A global (/g) regex's `.test()` advances lastIndex. The filter runs once
    // per module, so without cloning the flag away, matching would drift and
    // the same file would flip between included/excluded across calls.
    const filter = createSourceFilter(
      resolveOptions({
        include: [/src\/.*\.vue$/g],
        exclude: [/node_modules/g],
      }),
    );
    const included = path.join(root, "src", "App.vue");
    const excluded = path.join(root, "node_modules", "pkg", "App.vue");
    for (let i = 0; i < 5; i += 1) {
      expect(filter(included)).toBe(true);
      expect(filter(excluded)).toBe(false);
    }
  });
});

describe("createUnoCSSNativeContext", () => {
  it("extracts tokens per module and unions them on generate", async () => {
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

    const css = (await context.generate()).css;
    expect(css).toContain("color:red");
    expect(css).toContain("font-weight:700");
  });

  it("drops tokens when a module no longer references them", async () => {
    const context = createUnoCSSNativeContext(
      resolveOptions({
        configOrPath: {
          rules: [["text-red", { color: "red" }]],
        },
      }),
    );
    await context.ready;

    await context.transformModule(`<div class="text-red"></div>`, "a.vue");
    expect((await context.generate()).css).toContain("color:red");

    await context.transformModule(`<div></div>`, "a.vue");
    expect((await context.generate()).css).not.toContain("color:red");
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
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

    await context.transformModule(`<div class="text-red font-bold"></div>`, "a.vue");
    const second = await context.generate();

    expect(second).not.toBe(first);
    expect(second.css).toContain("font-weight:700");
  });
});

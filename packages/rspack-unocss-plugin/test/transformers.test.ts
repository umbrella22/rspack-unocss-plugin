import { describe, expect, it } from "vitest";
import { createGenerator, transformerVariantGroup } from "unocss";
import { applyTransformers } from "../src/transformers.js";

async function createUno() {
  return createGenerator({
    transformers: [transformerVariantGroup()],
  });
}

describe("applyTransformers", () => {
  it("rewrites the module source and returns a source map", async () => {
    const uno = await createUno();
    const code = `<div class="hover:(text-red-500 underline)"></div>`;

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    expect(result.code).toContain("hover:text-red-500");
    expect(result.code).toContain("hover:underline");
    expect(result.code).not.toContain("hover:(");
    expect(result.map).toBeDefined();
    expect(result.map?.mappings).toBeTypeOf("string");
  });

  it("returns the original code untouched when nothing changes", async () => {
    const uno = await createUno();
    const code = `<div class="text-red-500"></div>`;

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    expect(result.code).toBe(code);
    expect(result.map).toBeUndefined();
  });

  it("skips files marked with @unocss-ignore", async () => {
    const uno = await createUno();
    const code = `/* @unocss-ignore */\n<div class="hover:(text-red-500 underline)"></div>`;

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    expect(result.code).toBe(code);
    expect(result.map).toBeUndefined();
  });

  it("does nothing when no transformers are configured", async () => {
    const uno = await createGenerator({});
    const code = `<div class="hover:(text-red-500 underline)"></div>`;

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    expect(result.code).toBe(code);
    expect(result.map).toBeUndefined();
  });

  it("leaves @unocss-skip-start/end regions untransformed but rewrites the rest", async () => {
    const uno = await createUno();
    const code = [
      `<div class="hover:(text-red-500 underline)"></div>`,
      `/* @unocss-skip-start */`,
      `<div class="hover:(text-blue-500 italic)"></div>`,
      `/* @unocss-skip-end */`,
    ].join("\n");

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    // Outside the fence: variant group expanded.
    expect(result.code).toContain("hover:text-red-500");
    // Inside the fence: left verbatim, including the original comment markers.
    expect(result.code).toContain(`hover:(text-blue-500 italic)`);
    expect(result.code).toContain("@unocss-skip-start");
    expect(result.code).toContain("@unocss-skip-end");
  });
});

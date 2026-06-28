import { describe, expect, it } from "vitest";
import {
  createGenerator,
  transformerVariantGroup,
  type SourceCodeTransformer,
} from "unocss";
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

  it("restores multiple skip regions verbatim and in order", async () => {
    const uno = await createUno();
    const code = [
      `/* @unocss-skip-start */`,
      `<div class="hover:(text-blue-500 italic)"></div>`,
      `/* @unocss-skip-end */`,
      `<div class="hover:(text-red-500 underline)"></div>`,
      `/* @unocss-skip-start */`,
      `<div class="hover:(text-green-500 bold)"></div>`,
      `/* @unocss-skip-end */`,
    ].join("\n");

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    // Outside the fences: expanded.
    expect(result.code).toContain("hover:text-red-500");
    // First skip region survives intact.
    expect(result.code).toContain(`hover:(text-blue-500 italic)`);
    // Second skip region survives intact.
    expect(result.code).toContain(`hover:(text-green-500 bold)`);
    // Order is preserved: blue region before the red rewrite before green region.
    const blueIdx = result.code.indexOf(`hover:(text-blue-500 italic)`);
    const redIdx = result.code.indexOf("hover:text-red-500");
    const greenIdx = result.code.indexOf(`hover:(text-green-500 bold)`);
    expect(blueIdx).toBeLessThan(redIdx);
    expect(redIdx).toBeLessThan(greenIdx);
  });

  it("does not confuse two skip regions of identical length", async () => {
    const uno = await createUno();
    // Two skip regions whose fenced content has the exact same length but
    // different text. The previous space-based restore matched by "first
    // equal-length blank" and could misroute the second original onto the
    // first slot; the sentinel-based restore must keep them distinct.
    const first = `/* @unocss-skip-start */AAA1/* @unocss-skip-end */`;
    const second = `/* @unocss-skip-start */BBB2/* @unocss-skip-end */`;
    const code = `${first}\n<div class="hover:(text-red-500)"></div>\n${second}`;

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    expect(result.code).toContain("AAA1");
    expect(result.code).toContain("BBB2");
    expect(result.code.indexOf("AAA1")).toBeLessThan(
      result.code.indexOf("BBB2"),
    );
  });

  it("preserves dollar replacement sequences inside skip regions", async () => {
    const uno = await createUno();
    // A skip region containing literal `$` substitution patterns. Using
    // `replaceAll(placeholder, original)` would run the original through
    // `GetSubstitution`, silently turning "$1" into "" (empty capture) and
    // mangling the fenced source. split/join leaves it verbatim.
    const code = [
      `/* @unocss-skip-start */`,
      `const re = str.replace(/foo/g, "$1 $& $$ $'");`,
      `/* @unocss-skip-end */`,
      `<div class="hover:(text-red-500 underline)"></div>`,
    ].join("\n");

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    expect(result.code).toContain(`str.replace(/foo/g, "$1 $& $$ $'")`);
    // Outside the fence the variant group is still expanded.
    expect(result.code).toContain("hover:text-red-500");
  });

  it("combines source maps across multiple transforming transformers", async () => {
    // Two transformers that both rewrite the source, exercising the multi-map
    // remapping branch (maps.length >= 2). The combined map must be built and
    // remapping must not throw.
    const appendMarker: SourceCodeTransformer = {
      name: "append-marker",
      enforce: "default",
      transform(code) {
        code.appendRight(code.length, "\n/* marker */");
      },
    };
    const uno = await createGenerator({
      transformers: [transformerVariantGroup(), appendMarker],
    });
    const code = `<div class="hover:(text-red-500 underline)"></div>`;

    const result = await applyTransformers(code, "App.vue", {
      uno,
      tokens: new Set<string>(),
    });

    expect(result.code).toContain("hover:text-red-500");
    expect(result.code).toContain("/* marker */");
    expect(result.map).toBeDefined();
    expect(result.map?.mappings).toBeTypeOf("string");
    expect(result.map!.mappings.length).toBeGreaterThan(0);
  });
});

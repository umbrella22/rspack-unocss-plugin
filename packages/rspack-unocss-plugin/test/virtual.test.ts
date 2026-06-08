import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getHashPlaceholder,
  getLayerPlaceholder,
  getUnoCssLayer,
  getVirtualModuleContent,
  getVirtualPath,
  HASH_PLACEHOLDER_RE,
  isUnoCssId,
  isVirtualUnoPath,
  LAYER_MARK_ALL,
  LAYER_PLACEHOLDER_RE,
} from "../src/virtual.js";

describe("virtual css ids", () => {
  it("matches main uno css ids", () => {
    expect(isUnoCssId("uno.css")).toBe(true);
    expect(isUnoCssId("virtual:uno.css")).toBe(true);
    expect(isUnoCssId("uno.css?inline")).toBe(true);
  });

  it("matches layer uno css ids", () => {
    expect(isUnoCssId("uno:utilities.css")).toBe(true);
    expect(isUnoCssId("virtual:uno:preflights.css")).toBe(true);
    expect(isUnoCssId("uno:default.css?used")).toBe(true);
  });

  it("rejects non uno css ids", () => {
    expect(isUnoCssId("./uno.css")).toBe(false);
    expect(isUnoCssId("uno:utilities.js")).toBe(false);
    expect(isUnoCssId("@unocss/reset.css")).toBe(false);
  });

  it("extracts layer names", () => {
    expect(getUnoCssLayer("uno.css")).toBeUndefined();
    expect(getUnoCssLayer("uno:utilities.css")).toBe("utilities");
    expect(getUnoCssLayer("virtual:uno:preflights.css?inline")).toBe(
      "preflights",
    );
  });

  it("creates deterministic virtual paths", () => {
    const root = path.join("tmp", "project");

    expect(getVirtualPath(root)).toBe(
      path.join(root, "node_modules", ".rspack-unocss-plugin", "uno.css"),
    );
    expect(getVirtualPath(root, "utilities")).toBe(
      path.join(
        root,
        "node_modules",
        ".rspack-unocss-plugin",
        "uno_utilities.css",
      ),
    );
  });

  it("detects virtual uno module paths", () => {
    const root = path.join("tmp", "project");
    expect(isVirtualUnoPath(getVirtualPath(root))).toBe(true);
    expect(isVirtualUnoPath(getVirtualPath(root, "utilities"))).toBe(true);
    expect(isVirtualUnoPath(path.join(root, "src", "App.vue"))).toBe(false);
  });
});

describe("css placeholders", () => {
  it("round-trips a layer placeholder through its matcher", () => {
    const placeholder = getLayerPlaceholder("utilities");
    LAYER_PLACEHOLDER_RE.lastIndex = 0;
    const match = LAYER_PLACEHOLDER_RE.exec(placeholder);
    expect(match?.[1]).toBe("utilities");
  });

  it("round-trips the all-layers marker", () => {
    const placeholder = getLayerPlaceholder(LAYER_MARK_ALL);
    LAYER_PLACEHOLDER_RE.lastIndex = 0;
    expect(LAYER_PLACEHOLDER_RE.exec(placeholder)?.[1]).toBe(LAYER_MARK_ALL);
  });

  it("matches and strips the hash placeholder", () => {
    const placeholder = getHashPlaceholder("abcd1234");
    HASH_PLACEHOLDER_RE.lastIndex = 0;
    expect(HASH_PLACEHOLDER_RE.test(placeholder)).toBe(true);
    expect(placeholder.replace(HASH_PLACEHOLDER_RE, "")).toBe("");
  });

  it("builds module content with and without a hash", () => {
    expect(getVirtualModuleContent("utilities")).toBe(
      getLayerPlaceholder("utilities"),
    );
    expect(getVirtualModuleContent("utilities", "abcd1234")).toBe(
      getHashPlaceholder("abcd1234") + getLayerPlaceholder("utilities"),
    );
  });
});

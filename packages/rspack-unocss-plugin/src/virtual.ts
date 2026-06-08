import path from "node:path";

export const UNO_CSS_ID_RE = /^(?:virtual:)?uno(?::(.+))?\.css(?:\?.*)?$/;

/**
 * Marker layer name used by the main `uno.css` virtual module. At asset
 * generation time it expands to every layer that is not imported through a
 * dedicated `uno:<layer>.css` virtual module.
 */
export const LAYER_MARK_ALL = "__ALL__";

export function isUnoCssId(id: string) {
  return UNO_CSS_ID_RE.test(id);
}

export function getUnoCssLayer(id: string) {
  return id.match(UNO_CSS_ID_RE)?.[1];
}

export function getVirtualPath(root: string, layer?: string) {
  const name = layer ? `uno_${layer}.css` : "uno.css";
  return path.join(root, "node_modules", ".rspack-unocss-plugin", name);
}

/**
 * Returns true when the given absolute path points at one of the plugin's
 * virtual CSS modules. Used by the loader to avoid transforming or extracting
 * tokens from generated CSS.
 */
export function isVirtualUnoPath(file: string) {
  return file.includes(`${path.sep}.rspack-unocss-plugin${path.sep}`);
}

/**
 * Placeholder rule injected into each virtual CSS module. It is a valid CSS
 * rule using a custom property so that it survives Rspack's native CSS parsing
 * untouched, and is replaced with the real generated CSS during `processAssets`.
 *
 * Capture group `1` is the layer name.
 */
export const LAYER_PLACEHOLDER_RE =
  /#unocss-layer\s*\{\s*--l\s*:\s*([^;}]+?)\s*;?\s*\}/g;

export function getLayerPlaceholder(layer: string) {
  return `#unocss-layer{--l:${layer}}`;
}

/**
 * Placeholder carrying the content hash of the generated CSS. Its only purpose
 * is to change the virtual module's content (and therefore the chunk hash) when
 * the generated CSS changes, so watch mode re-emits the asset. It is stripped
 * from the final asset during `processAssets`.
 */
export const HASH_PLACEHOLDER_RE =
  /#unocss-hash\s*\{\s*--h\s*:\s*"[^"]*"\s*;?\s*\}/g;

export function getHashPlaceholder(hash: string) {
  return `#unocss-hash{--h:"${hash}"}`;
}

/**
 * Builds the content of a virtual CSS module from the layer it represents and
 * an optional content hash.
 */
export function getVirtualModuleContent(layer: string, hash?: string) {
  const layerPlaceholder = getLayerPlaceholder(layer);
  return hash ? getHashPlaceholder(hash) + layerPlaceholder : layerPlaceholder;
}

import type { UnoCSSNativeContext } from "./context.js";

/**
 * Shared registry that lets the Rspack loader reach the plugin instance's
 * UnoCSS context. Loaders run in the same Node process as the plugin, so both
 * sides import this module and resolve the same singleton map keyed by a unique
 * per-plugin id.
 */
const contexts = new Map<string, UnoCSSNativeContext>();

let nextId = 0;

export function createContextId() {
  nextId += 1;
  return `rspack-unocss-${process.pid}-${nextId}`;
}

export function registerContext(id: string, context: UnoCSSNativeContext) {
  contexts.set(id, context);
}

export function getRegisteredContext(id: string) {
  return contexts.get(id);
}

export function unregisterContext(id: string) {
  contexts.delete(id);
}

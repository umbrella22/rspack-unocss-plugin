import type { LoaderContext } from "@rspack/core";
import { getRegisteredContext } from "./registry.js";
import { isVirtualUnoPath } from "./virtual.js";

export interface UnoLoaderOptions {
  unoId: string;
}

/**
 * Rspack loader that runs the UnoCSS transformer pipeline on a module's source
 * and records its tokens in the shared context. It deliberately operates on the
 * `source` passed by Rspack (never reading from disk), and skips loader
 * sub-requests carrying a query such as Vue's `?vue&type=style`, which is why it
 * avoids the `ENOENT` problems of resource-path based extraction.
 */
export default function unoLoader(
  this: LoaderContext<UnoLoaderOptions>,
  source: string,
  map?: Parameters<LoaderContext["callback"]>[2],
) {
  const callback = this.async();
  const { unoId } = this.getOptions();
  const context = getRegisteredContext(unoId);
  const resourcePath = this.resourcePath;

  // Skip sub-requests (e.g. `?vue&type=style`), the plugin's own virtual CSS,
  // and anything the source filter rejects — these are never extracted.
  if (
    this.resourceQuery ||
    isVirtualUnoPath(resourcePath) ||
    (context ? !context.shouldExtract(resourcePath) : false)
  ) {
    callback(null, source, map);
    return;
  }

  // A missing context for a file we would otherwise extract means this loader is
  // running outside the plugin's process/realm — almost always because it was
  // scheduled into a worker thread via Rspack's `parallel` loader option, where
  // the in-process registry singleton is a fresh empty map. Warn loudly instead
  // of silently dropping the file's classes from the generated CSS.
  if (!context) {
    this.emitWarning(
      new Error(
        `rspack-unocss-plugin: no UnoCSS context for "${resourcePath}". ` +
          "The loader cannot reach the plugin instance, which happens when it " +
          "runs in a worker thread. Do not enable the `parallel` loader option " +
          "for this loader; UnoCSS extraction must run on the main thread.",
      ),
    );
    callback(null, source, map);
    return;
  }

  context
    .transformModule(source, resourcePath)
    .then((result) => {
      callback(null, result.code, (result.map as typeof map) ?? map);
    })
    .catch((error: Error) => callback(error));
}

import type {
  SourceCodeTransformer,
  UnocssPluginContext,
  UnoGenerator,
} from "unocss";
import MagicString, { type SourceMap } from "magic-string";
import remapping from "@jridgewell/remapping";

const transformerEnforces = ["pre", "default", "post"] as const;

/**
 * Matches `@unocss-skip-start` / `@unocss-skip-end` block-comment fences. The
 * region between a start and its matching end is blanked before transformers
 * run, so utilities inside it are neither rewritten nor extracted. Mirrors
 * UnoCSS's official `SKIP_COMMENT_RE`.
 */
const SKIP_START_RE = /@unocss-skip-start/g;
const SKIP_END = "@unocss-skip-end";

export interface TransformerContextOptions {
  uno: UnoGenerator;
  tokens: Set<string>;
}

export interface TransformResult {
  code: string;
  /** Combined source map of all transformers, or `undefined` when unchanged. */
  map?: SourceMap;
}

/**
 * Runs the configured UnoCSS source transformers against a module's code in
 * `pre`, `default`, and `post` order. Unlike a token-only extraction pass, this
 * actually rewrites the module source (so variant groups, directives, etc. are
 * reflected at runtime) and combines the transformers' source maps so the
 * loader can forward an accurate map to Rspack.
 */
export async function applyTransformers(
  code: string,
  id: string,
  options: TransformerContextOptions,
): Promise<TransformResult> {
  const { uno, tokens } = options;
  const transformers = uno.config.transformers ?? [];
  if (transformers.length === 0 || code.includes("@unocss-ignore")) {
    return { code };
  }

  const transformerContext = {
    uno,
    tokens,
    getConfig: () => uno.config,
    invalidate: () => {
      tokens.clear();
    },
  } as unknown as UnocssPluginContext;

  // Blank out `@unocss-skip-start ... @unocss-skip-end` regions before running
  // transformers so utilities inside them are neither rewritten nor extracted,
  // then restore the original text afterwards.
  const { masked, restore } = maskSkipRegions(code);

  const original = masked;
  const maps: ReturnType<MagicString["generateMap"]>[] = [];
  let working = masked;
  let current = new MagicString(masked);

  for (const enforce of transformerEnforces) {
    for (const transformer of transformers) {
      const sourceTransformer = transformer as SourceCodeTransformer;
      if ((sourceTransformer.enforce ?? "default") !== enforce) continue;
      if (sourceTransformer.idFilter && !sourceTransformer.idFilter(id))
        continue;

      await sourceTransformer.transform(current, id, transformerContext);

      // Re-base the MagicString so the next transformer operates on the
      // already-transformed code, and capture this step's source map.
      if (current.hasChanged()) {
        working = current.toString();
        maps.push(current.generateMap({ hires: true, source: id }));
        current = new MagicString(working);
      }
    }
  }

  if (working === original) return { code };

  const combined: SourceMap =
    maps.length === 1
      ? maps[0]
      : (remapping(maps as never, () => null) as unknown as SourceMap);

  return { code: restore(working), map: combined };
}

/**
 * Replaces every `@unocss-skip-start ... @unocss-skip-end` region with spaces of
 * equal length so transformers leave them alone while offsets stay stable.
 * Returns the masked source plus a `restore` that splices the originals back in.
 * Unterminated start fences mask through to end of file, matching UnoCSS.
 */
function maskSkipRegions(code: string): {
  masked: string;
  restore: (transformed: string) => string;
} {
  SKIP_START_RE.lastIndex = 0;
  const ranges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = SKIP_START_RE.exec(code))) {
    const start = match.index;
    const endIndex = code.indexOf(SKIP_END, start);
    const end =
      endIndex === -1 ? code.length : endIndex + SKIP_END.length;
    ranges.push([start, end]);
    SKIP_START_RE.lastIndex = end;
  }

  if (ranges.length === 0) {
    return { masked: code, restore: (transformed) => transformed };
  }

  let masked = "";
  let cursor = 0;
  const originals: string[] = [];
  for (const [start, end] of ranges) {
    masked += code.slice(cursor, start);
    originals.push(code.slice(start, end));
    masked += " ".repeat(end - start);
    cursor = end;
  }
  masked += code.slice(cursor);

  // The masked regions are spaces no transformer touches, so they survive intact
  // in the output; swap each back to its original text by index.
  const restore = (transformed: string) => {
    let result = transformed;
    for (const original of originals) {
      const blank = " ".repeat(original.length);
      result = result.replace(blank, () => original);
    }
    return result;
  };

  return { masked, restore };
}

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

/**
 * Prefix for the unique sentinel each masked skip region is replaced with.
 * Mirrors UnoCSS's official `transformSkipCode`/`restoreSkipCode` strategy: a
 * unique sentinel that no source transformer matches as a class, so `restore`
 * can splice each original back by key (`replaceAll`) rather than by the
 * ambiguous "first equal-length blank" the previous space-based masking used.
 */
const SKIP_PLACEHOLDER_PREFIX = "@unocss-skip-placeholder-";

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

  // `maps` was pushed oldest-transformation-first (in execution order), but
  // `@jridgewell/remapping`'s array form expects the most recent
  // transformation first — it `pop()`s the last entry as the root (original
  // side) and wraps the rest outward. Reverse before passing so the combined
  // source map reflects the real transform chain instead of an inverted one.
  const combined: SourceMap =
    maps.length === 1
      ? maps[0]
      : (remapping(
          [...maps].reverse() as never,
          () => null,
        ) as unknown as SourceMap);

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
    const end = endIndex === -1 ? code.length : endIndex + SKIP_END.length;
    ranges.push([start, end]);
    SKIP_START_RE.lastIndex = end;
  }

  if (ranges.length === 0) {
    return { masked: code, restore: (transformed) => transformed };
  }

  // Replace each skip region with a unique sentinel. Unlike equal-length
  // spaces, a unique sentinel lets `restore` splice each original back by key
  // (via replaceAll) instead of by "first equal-length blank", which was
  // ambiguous when multiple regions shared a length, or when a transformer
  // inserted equally-sized whitespace elsewhere in the file. The sentinel looks
  // like a class/identifier fragment that no transformer treats as a token.
  const replacements = new Map<string, string>();
  let masked = "";
  let cursor = 0;
  ranges.forEach((range, index) => {
    const [start, end] = range;
    masked += code.slice(cursor, start);
    // Pad the sentinel to the region's length so character offsets in `masked`
    // stay aligned with the original `code`. Source maps are generated against
    // `masked`; keeping each sentinel the same length as the original it stands
    // in for means `restore` (which swaps a sentinel back to its original) does
    // not shift any downstream position, so the maps stay accurate. Regions
    // shorter than the sentinel prefix are left as-is — `padEnd` never truncates,
    // and real skip regions always contain the start/end comment markers.
    const placeholder = `${SKIP_PLACEHOLDER_PREFIX}${index}__`.padEnd(
      end - start,
      " ",
    );
    replacements.set(placeholder, code.slice(start, end));
    masked += placeholder;
    cursor = end;
  });
  masked += code.slice(cursor);

  // Each sentinel is unique, so restoring exactly one region per entry is
  // safe — but use `split`/`join` rather than `replaceAll`. A string
  // replacement value is run through `GetSubstitution`, which would silently
  // mangle any `$` sequences in the original skip-region source (e.g. `$1`,
  // `$&`, `$'` that users legitimately keep inside fenced blocks).
  const restore = (transformed: string) => {
    let result = transformed;
    for (const [placeholder, original] of replacements) {
      result = result.split(placeholder).join(original);
    }
    return result;
  };

  return { masked, restore };
}

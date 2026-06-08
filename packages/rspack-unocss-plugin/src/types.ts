import type { LightningcssLoaderOptions } from "@rspack/core";
import type { UserConfig } from "unocss";

export interface UnoCSSRspackNativePluginOptions {
  configOrPath?: string | UserConfig;
  defaults?: UserConfig;
  root?: string;
  include?: Array<string | RegExp>;
  exclude?: Array<string | RegExp>;
  virtualModuleId?: string;
  autoCssRule?: boolean;
  /**
   * Opt in to Rspack's `builtin:lightningcss-loader` for the fallback CSS rule.
   * Pass `true` for defaults, or an options object forwarded to the loader.
   * Only applied when {@link UnoCSSRspackNativePluginOptions.autoCssRule} injects
   * the rule. Defaults to `false`; native CSS and the minimizer already cover
   * common cases. PostCSS is never enabled by default — configure
   * `postcss-loader` yourself if you need it.
   */
  lightningcss?: boolean | LightningcssLoaderOptions;
  watch?: boolean;
}

export interface ResolvedUnoCSSRspackNativePluginOptions {
  configOrPath?: string | UserConfig;
  defaults?: UserConfig;
  root: string;
  include: Array<string | RegExp>;
  exclude: Array<string | RegExp>;
  virtualModuleId: string;
  autoCssRule: boolean;
  lightningcss: boolean | LightningcssLoaderOptions;
  watch: boolean;
  minify: boolean;
}

import {
  defineConfig,
  presetAttributify,
  presetIcons,
  presetTypography,
  transformerDirectives,
  transformerVariantGroup,
} from "unocss";
import presetWind4 from "@unocss/preset-wind4";

export default defineConfig({
  presets: [
    presetAttributify(),
    presetIcons({
      extraProperties: {
        display: "inline-block",
      },
    }),
    presetTypography(),
    presetWind4({
      preflights: {
        reset: true,
      },
    }),
  ],
  transformers: [
    transformerVariantGroup(),
    transformerDirectives({
      enforce: "pre",
    }),
  ],
});

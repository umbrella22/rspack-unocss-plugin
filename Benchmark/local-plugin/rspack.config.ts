import { defineConfig } from "@rspack/cli";
import { rspack } from "@rspack/core";
import { VueLoaderPlugin } from "rspack-vue-loader";
import { UnoCSSRspackNativePlugin } from "rspack-unocss-plugin";

const targets = ["last 2 versions", "> 0.2%", "not dead", "Firefox ESR"];

export default defineConfig({
  mode: "production",
  entry: {
    index: "./src/main.ts",
  },
  output: {
    clean: true,
  },
  resolve: {
    extensions: ["...", ".ts", ".jsx", ".vue"],
  },
  experiments: {
    css: true,
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: {
              syntax: "typescript",
            },
          },
        },
        type: "javascript/auto",
      },
      {
        test: /\.vue$/,
        loader: "rspack-vue-loader",
        options: {
          experimentalInlineMatchResource: true,
        },
      },
    ],
  },
  plugins: [
    new UnoCSSRspackNativePlugin({
      include: [/src\/.*\.(vue|ts)$/],
    }),
    new VueLoaderPlugin(),
    new rspack.HtmlRspackPlugin({
      template: "./index.html",
    }),
  ],
  optimization: {
    minimizer: [
      new rspack.SwcJsMinimizerRspackPlugin(),
      new rspack.LightningCssMinimizerRspackPlugin({
        minimizerOptions: { targets },
      }),
    ],
  },
  devServer: {
    hot: true,
  },
});

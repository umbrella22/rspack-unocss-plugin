import { defineConfig } from "@rspack/cli";
import { rspack } from "@rspack/core";
import { VizePlugin } from "@vizejs/rspack-plugin";
import { UnoCSSRspackNativePlugin } from "rspack-unocss-plugin";

const isProduction = process.env.NODE_ENV === "production";

// Target browsers, see: https://github.com/browserslist/browserslist
const targets = ["last 2 versions", "> 0.2%", "not dead", "Firefox ESR"];

export default defineConfig({
  entry: {
    index: "./src/main.ts",
  },
  output: {
    clean: true,
  },
  resolve: {
    extensions: ["...", ".ts", ".jsx", ".vue"],
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
        loader: "@vizejs/rspack-plugin/loader",
      },
    ],
  },
  plugins: [
    new UnoCSSRspackNativePlugin(),
    new VizePlugin({
      isProduction,
    }),
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

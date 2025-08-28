const path = require("path");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");
const webpack = require("webpack");

module.exports = {
  mode: "production",
  entry: {
    "submissions-api": "./tests/performance/submissions-api.ts",
    "db-tps": "./tests/performance/db-tps.ts"
  },
  output: {
    path: path.resolve(__dirname, "dist/k6-tests"),
    filename: "[name].js",
    libraryTarget: "commonjs"
  },
  target: "web",
  externals: [
    // k6 built-in modules
    "k6",
    "k6/crypto",
    "k6/data",
    "k6/encoding",
    "k6/execution",
    "k6/experimental",
    "k6/html",
    "k6/http",
    "k6/metrics",
    "k6/net/grpc",
    "k6/util",
    "k6/ws"
  ],
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    alias: {
      "@": path.resolve(__dirname, "./")
    },
    fallback: {
      // Node.js polyfills for browser/k6 environment
      path: false,
      os: false,
      crypto: false,
      fs: false,
      buffer: require.resolve("buffer"),
      process: require.resolve("process/browser"),
      stream: false,
      util: false,
      assert: false,
      http: false,
      https: false,
      url: false,
      querystring: false
    }
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: [
          {
            loader: "ts-loader",
            options: {
              transpileOnly: true,
              configFile: path.resolve(__dirname, "tsconfig.json"),
              compilerOptions: {
                module: "commonjs",
                target: "es2017",
                lib: ["es2017"],
                moduleResolution: "node",
                allowSyntheticDefaultImports: true,
                esModuleInterop: true,
                skipLibCheck: true,
                strict: false,
                noImplicitAny: false,
                // Disable DOM types for k6 environment
                types: ["node"]
              }
            }
          }
        ],
        exclude: /node_modules/
      }
    ]
  },
  plugins: [
    new CleanWebpackPlugin({
      cleanOnceBeforeBuildPatterns: ["dist/k6-tests/**/*"]
    }),
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.version": JSON.stringify("v18.0.0"),
      "process.platform": JSON.stringify("linux")
    }),
    new webpack.ProvidePlugin({
      process: "process/browser",
      Buffer: ["buffer", "Buffer"]
    })
  ],
  optimization: {
    minimize: false // Keep readable for debugging
  },
  stats: {
    colors: true,
    errors: true,
    warnings: true,
    timings: true
  }
};

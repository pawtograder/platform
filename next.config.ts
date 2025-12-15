import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    optimizePackageImports: [
      "@chakra-ui/react",
      "@monaco-editor/react",
      "recharts",
      "@tabler/icons-react",
      "react-icons",
      "@uiw/react-md-editor",
      "react-markdown"
    ]
  },

  // Optimize webpack for reduced memory usage during build
  webpack: (config, { isServer, dev }) => {
    // Optimize cache to reduce memory usage
    if (config.cache && !dev) {
      // Reduce cache memory footprint
      config.cache = {
        ...config.cache,
        maxMemoryGenerations: 1 // Reduce cache generations
      };
    }

    if (!isServer) {
      // Optimize chunk splitting to reduce memory pressure
      config.optimization = {
        ...config.optimization,
        moduleIds: "deterministic",
        splitChunks: {
          chunks: "all",
          maxInitialRequests: 25, // Limit initial chunks
          maxAsyncRequests: 30, // Limit async chunks
          cacheGroups: {
            default: false,
            vendors: false,
            // Split large libraries into separate chunks to reduce memory during build
            monaco: {
              name: "monaco-editor",
              test: /[\\/]node_modules[\\/](@monaco-editor|monaco-editor|monaco-yaml)[\\/]/,
              priority: 20,
              reuseExistingChunk: true,
              enforce: true
            },
            chakra: {
              name: "chakra-ui",
              test: /[\\/]node_modules[\\/]@chakra-ui[\\/]/,
              priority: 15,
              reuseExistingChunk: true,
              enforce: true
            },
            charts: {
              name: "charts",
              test: /[\\/]node_modules[\\/](recharts|@chakra-ui\/charts)[\\/]/,
              priority: 10,
              reuseExistingChunk: true,
              enforce: true
            },
            mdEditor: {
              name: "md-editor",
              test: /[\\/]node_modules[\\/]@uiw[\\/]react-md-editor[\\/]/,
              priority: 10,
              reuseExistingChunk: true,
              enforce: true
            },
            mathjs: {
              name: "mathjs",
              test: /[\\/]node_modules[\\/]mathjs[\\/]/,
              priority: 10,
              reuseExistingChunk: true,
              enforce: true
            }
          }
        }
      };
    }

    // Reduce memory usage by limiting parallel processing
    // This helps prevent OOM errors during build
    if (config.optimization?.minimizer) {
      config.optimization.minimizer = config.optimization.minimizer.map((plugin: unknown) => {
        if (
          plugin &&
          typeof plugin === "object" &&
          "constructor" in plugin &&
          plugin.constructor.name === "SwcMinify"
        ) {
          // SWC minifier is already memory-efficient
          return plugin;
        }
        return plugin;
      });
    }

    // Optimize module resolution to reduce memory
    if (config.resolve) {
      config.resolve.cache = false; // Disable resolve cache to save memory
    }

    return config;
  }
};
// Make sure adding Sentry options is the last code to run before exporting
export default withSentryConfig(nextConfig, {
  tunnelRoute: true, // avoids ad blockers
  org: "pawtograder",
  project: "pawtograder-web",
  reactComponentAnnotation: {
    enabled: true
  },
  // Only print logs for uploading source maps in CI
  // Set to `true` to suppress logs
  silent: !process.env.CI,
  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: true
});

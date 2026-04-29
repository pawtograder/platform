import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const bundlingProfile = process.env.NEXT_BUNDLING_PROFILE ?? "worker";
const useLegacyWebpackTweaks = bundlingProfile === "legacy";
const useWebpackBuildWorker = bundlingProfile === "worker";
const disableSentryBundlingPlugin = process.env.NEXT_DISABLE_SENTRY === "1";
const isCi = process.env.CI === "1" || process.env.CI === "true";
const sentryBuildProfile = process.env.SENTRY_BUILD_PROFILE ?? (isCi ? "ci-fast" : "full");
const useFastSentryBuildProfile = sentryBuildProfile === "ci-fast";
const disableSentryComponentAnnotation =
  process.env.SENTRY_DISABLE_COMPONENT_ANNOTATION === "1" || useFastSentryBuildProfile;
const disableSentryRouteManifestInjection =
  process.env.SENTRY_DISABLE_ROUTE_MANIFEST_INJECTION === "1" || useFastSentryBuildProfile;
const disableSentryReleaseCreate = process.env.SENTRY_DISABLE_RELEASE_CREATE === "1";
const disableSentryReleaseFinalize = process.env.SENTRY_DISABLE_RELEASE_FINALIZE === "1";
const disableSentrySourcemaps = process.env.SENTRY_DISABLE_SOURCEMAPS === "1";
const useSentryRunAfterProductionCompileHook = process.env.SENTRY_USE_RUN_AFTER_PRODUCTION_COMPILE === "1";

const optimizePackageImports = [
  "@chakra-ui/react",
  "@monaco-editor/react",
  "recharts",
  "@tabler/icons-react",
  "react-icons",
  "@uiw/react-md-editor",
  "react-markdown"
];

const nextConfig: NextConfig = {
  output: process.env.NEXT_OUTPUT_STANDALONE === "true" ? "standalone" : undefined,
  experimental: {
    optimizePackageImports,
    ...(useWebpackBuildWorker ? { webpackBuildWorker: true } : {}),
    // Re-enable client-side Router Cache for dynamic layouts.
    //
    // Next 15 dropped `staleTimes.dynamic` from the Next-14 default of 30s
    // to 0, which means *every* client-side navigation re-fetches dynamic
    // RSC segments. Our `app/course/[course_id]/layout.tsx` is dynamic
    // because it reads `headers()` (to pull the middleware-injected
    // `X-User-ID` for the per-course role check + course-controller
    // initial-data fetch). With `dynamic: 0`, the discussion-perf trace
    // showed a stable ~4 s click-to-content gap on every thread nav,
    // dominated by re-shipping the entire `CourseControllerInitialData`
    // (profiles, user_roles, all discussion_threads, tags, lab sections,
    // …) as part of the layout RSC payload on each request.
    //
    // 30s is the old Next-14 default — restoring it lets a session of
    // intra-course navigations reuse the cached layout while still
    // picking up role / enrollment changes within a minute on idle. The
    // server-side fetch cache (see `createClientWithCaching` in
    // `lib/ssrUtils.ts`) plus its trigger-based tag revalidation still
    // governs how quickly data writes propagate; staleTimes only
    // controls how often the client re-asks the server for the same
    // logical segment.
    staleTimes: {
      dynamic: 30,
      static: 300
    }
  },
  ...(useLegacyWebpackTweaks
    ? {
        // Keep legacy memory-optimized webpack behavior available via NEXT_BUNDLING_PROFILE=legacy.
        webpack: (config, { isServer, dev }) => {
          if (config.cache && !dev) {
            config.cache = {
              ...config.cache,
              maxMemoryGenerations: 1
            };
          }

          if (!isServer) {
            config.optimization = {
              ...config.optimization,
              moduleIds: "deterministic",
              splitChunks: {
                chunks: "all",
                maxInitialRequests: 25,
                maxAsyncRequests: 30,
                cacheGroups: {
                  default: false,
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

          if (config.optimization?.minimizer) {
            config.optimization.minimizer = config.optimization.minimizer.map((plugin: unknown) => {
              if (!plugin || typeof plugin !== "object" || !("constructor" in plugin)) {
                return plugin;
              }

              const pluginName = plugin.constructor.name;

              if (pluginName === "SwcMinify") {
                return plugin;
              }

              if (pluginName === "TerserPlugin") {
                const terserPlugin = plugin as {
                  options?: { parallel?: boolean; terserOptions?: { compress?: { passes?: number } } };
                };
                if (terserPlugin.options) {
                  terserPlugin.options.parallel = false;
                  if (terserPlugin.options.terserOptions?.compress) {
                    terserPlugin.options.terserOptions.compress.passes = 1;
                  }
                }
                return plugin;
              }

              if (pluginName === "CssMinimizerPlugin") {
                const cssPlugin = plugin as { options?: { parallel?: boolean } };
                if (cssPlugin.options) {
                  cssPlugin.options.parallel = false;
                }
                return plugin;
              }

              return plugin;
            });
          }

          if (config.resolve) {
            config.resolve.cache = false;
          }

          return config;
        }
      }
    : {})
};

// Skip Sentry webpack integration when DSN is unset (local dev) or explicitly disabled (CI speed).
const hasSentryDsn = !!process.env.NEXT_PUBLIC_BUGSINK_DSN;

const sentryConfig = {
  tunnelRoute: true,
  org: "pawtograder",
  project: "pawtograder-web",
  // Keep Sentry enabled in CI while reducing build-time-only instrumentation overhead.
  routeManifestInjection: disableSentryRouteManifestInjection ? false : true,
  reactComponentAnnotation: {
    enabled: !disableSentryComponentAnnotation
  },
  sourcemaps: {
    disable: disableSentrySourcemaps
  },
  useRunAfterProductionCompileHook: useSentryRunAfterProductionCompileHook,
  release: {
    create: !disableSentryReleaseCreate,
    finalize: !disableSentryReleaseFinalize
  },
  silent: !isCi,
  disableLogger: true
};

export default hasSentryDsn && !disableSentryBundlingPlugin ? withSentryConfig(nextConfig, sentryConfig) : nextConfig;

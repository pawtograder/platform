import type { NextConfig } from "next";
import path from "node:path";
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

const coverageBuild = process.env.COVERAGE === "1";

const nextConfig: NextConfig = {
  output: process.env.NEXT_OUTPUT_STANDALONE === "true" ? "standalone" : undefined,
  // V8 client coverage (collected by Playwright) needs sourcemaps to
  // resolve compiled chunks back to .ts/.tsx. Enabled only in coverage
  // builds — production builds keep maps off (faster build, smaller
  // artifact, no IP leak in browser DevTools).
  productionBrowserSourceMaps: coverageBuild,
  // Shared cross-replica cache. The default Next cache is per-instance, so with
  // >1 web replica `revalidateTag()` only invalidates the pod that handled the
  // request and the others serve stale data. `cache-handler.cjs` backs the
  // cache with the shared in-cluster Redis (REDIS_URL); it degrades to a
  // per-process in-memory Map when REDIS_URL is unset, so local/dev builds are
  // unaffected. `cacheMaxMemorySize: 0` disables Next's extra default in-memory
  // layer in favour of the handler. Force-include the handler + ioredis in the
  // standalone trace so `node server.js` can require them at runtime.
  cacheHandler: path.join(process.cwd(), "cache-handler.cjs"),
  cacheMaxMemorySize: 0,
  outputFileTracingIncludes: {
    "/**": ["./cache-handler.cjs"]
  },
  experimental: {
    optimizePackageImports,
    ...(useWebpackBuildWorker ? { webpackBuildWorker: true } : {}),
    // Coverage builds: keep the Node server bundle UNMINIFIED. Server-side
    // V8 coverage records byte ranges over the compiled bundle and maps
    // them back through the source map; minified output collapses many
    // statements onto a single position, so the resolution lands on
    // coarse/wrong original lines (covered code attributed to the wrong
    // function, called-function bodies dropped). Next gates node-server
    // minification on this flag (webpack-config.js: `isNodeServer &&
    // config.experimental.serverMinification`), default true — the webpack
    // tweak below also forces `optimization.minimize = false` on the
    // server, but disabling it here keeps Next's own pipeline honest.
    ...(coverageBuild ? { serverMinification: false } : {}),
    // Coverage builds: drop the client Router Cache TTL to 0 so EVERY
    // client-side navigation re-fetches its RSC segment from the server.
    // Server Components only execute server-side when their segment is
    // fetched fresh; with the production `dynamic: 30` cache, a session of
    // intra-course navigations reuses cached segments and the server
    // component never re-renders, so it shows 0% server coverage (and which
    // routes happen to render at all becomes run-to-run luck). Forcing 0
    // makes runtime server-component coverage track exactly what the E2E
    // navigates to, completely and deterministically. Prod keeps 30/300.
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
    staleTimes: coverageBuild
      ? {
          dynamic: 0,
          static: 0
        }
      : {
          dynamic: 30,
          static: 300
        }
  },
  // Coverage-build webpack tweaks:
  // - Both bundles: disable SWC/Terser minification. V8 records byte
  //   ranges over the COMPILED output and we map them back through the
  //   source map. Minified code collapses many statements onto a single
  //   position, so the byte-range→source-map resolution lands on
  //   coarse/wrong original lines — covered code gets attributed to the
  //   wrong function and called-function bodies vanish (the "coverage
  //   pattern doesn't line up" symptom on e.g. app/actions.ts). Keeping
  //   the output unminified preserves a ~1:1 statement layout so the
  //   resolution stays line-accurate. Bundle size is irrelevant in CI.
  //   (The server is ALSO gated by experimental.serverMinification, set
  //   false above; this override is the belt to that suspenders.)
  // - Server: additionally emit source maps so the Inspector-based
  //   server collector (instrumentation.ts) can resolve the vm-loaded
  //   Server Component / server-action bundles back to source.
  ...(coverageBuild
    ? {
        webpack: (config: { devtool?: string; optimization?: { minimize?: boolean } }, ctx: { isServer: boolean }) => {
          if (config.optimization) {
            config.optimization.minimize = false;
          }
          if (ctx.isServer) {
            config.devtool = "source-map";
          }
          return config;
        }
      }
    : useLegacyWebpackTweaks
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

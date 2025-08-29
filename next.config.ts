import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    optimizePackageImports: ["@chakra-ui/react"]
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
  silent: !process.env["CI"],
  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: true
});

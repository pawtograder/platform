import type { StorybookConfig } from "@storybook/nextjs";
import path from "path";

const config: StorybookConfig = {
  framework: {
    name: "@storybook/nextjs",
    options: {}
  },
  stories: [
    "../components/**/*.stories.@(js|jsx|ts|tsx)",
    "../stories/**/*.stories.@(js|jsx|ts|tsx)"
  ],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-interactions"
  ],
  staticDirs: [
    { from: "../public", to: "/" }
  ],
  webpackFinal: async (config) => {
    if (!config.resolve) config.resolve = {};
    if (!config.resolve.alias) config.resolve.alias = {} as any;

    // Base alias for project root
    (config.resolve.alias as any)["@"] = path.resolve(__dirname, "..");

    // Alias Next.js app router navigation to Storybook-friendly mocks
    config.resolve.alias["next/navigation"] = path.resolve(
      __dirname,
      "mocks/next-navigation.ts"
    );

    // Alias hooks to mocked implementations for isolated rendering
    config.resolve.alias["@/hooks/useAssignment"] = path.resolve(
      __dirname,
      "mocks/hooks/useAssignment.tsx"
    );
    config.resolve.alias["@/hooks/useSubmission"] = path.resolve(
      __dirname,
      "mocks/hooks/useSubmission.tsx"
    );
    config.resolve.alias["@/hooks/useSubmission.tsx"] = path.resolve(
      __dirname,
      "mocks/hooks/useSubmission.tsx"
    );
    config.resolve.alias["@/hooks/useSubmissionReview"] = path.resolve(
      __dirname,
      "mocks/hooks/useSubmissionReview.tsx"
    );
    config.resolve.alias["@/hooks/useClassProfiles"] = path.resolve(
      __dirname,
      "mocks/hooks/useClassProfiles.tsx"
    );
    config.resolve.alias["@/hooks/useRubricVisibility"] = path.resolve(
      __dirname,
      "mocks/hooks/useRubricVisibility.ts"
    );
    config.resolve.alias["@/hooks/useCourseController"] = path.resolve(
      __dirname,
      "mocks/hooks/useCourseController.tsx"
    );

    // Mock refine core hooks used across components
    config.resolve.alias["@refinedev/core"] = path.resolve(
      __dirname,
      "mocks/refine-core.ts"
    );

    // Mock Supabase client used by components like artifact viewers
    config.resolve.alias["@/utils/supabase/client"] = path.resolve(
      __dirname,
      "mocks/utils-supabase-client.ts"
    );

    // Hard override absolute source files in case path alias resolution bypasses module name
    config.resolve.alias[path.resolve(__dirname, "../hooks/useSubmission.tsx")] = path.resolve(
      __dirname,
      "mocks/hooks/useSubmission.tsx"
    );
    config.resolve.alias[path.resolve(__dirname, "../hooks/useSubmission")] = path.resolve(
      __dirname,
      "mocks/hooks/useSubmission.tsx"
    );
    config.resolve.alias[path.resolve(__dirname, "../hooks/useSubmissionReview.tsx")] = path.resolve(
      __dirname,
      "mocks/hooks/useSubmissionReview.tsx"
    );
    config.resolve.alias[path.resolve(__dirname, "../hooks/useAssignment.tsx")] = path.resolve(
      __dirname,
      "mocks/hooks/useAssignment.tsx"
    );

    return config;
  }
};

export default config;

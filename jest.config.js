// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextJest = require("next/jest");

const createJestConfig = nextJest({
  dir: "./"
});

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts", "<rootDir>/tests/unit/**/*.test.tsx"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    // Map isows ESM to CJS version to avoid import issues
    "^isows/_esm/(.*)$": "<rootDir>/node_modules/isows/_cjs/$1",
    "^isows$": "<rootDir>/node_modules/isows/_cjs/index.js",
    // jose resolves to its ESM browser build under jsdom; use the CJS build in tests
    "^jose$": "<rootDir>/node_modules/jose/dist/node/cjs/index.js"
  },
  // Handle module resolution for TypeScript
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  // Transform ESM modules from Supabase dependencies
  transformIgnorePatterns: ["node_modules/(?!(isows|@supabase/realtime-js|@supabase/supabase-js|ws|@supabase|jose)/)"],
  collectCoverageFrom: [
    "app/**/*.{ts,tsx}",
    "components/**/*.{ts,tsx}",
    "hooks/**/*.{ts,tsx}",
    "lib/**/*.{ts,tsx}",
    "utils/**/*.{ts,tsx}",
    "!**/*.d.ts",
    "!**/node_modules/**"
  ]
};

module.exports = createJestConfig(customJestConfig);

const nextJest = require("next/jest");

const createJestConfig = nextJest({
  dir: "./"
});

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts", "<rootDir>/tests/unit/**/*.test.tsx"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1"
  }
};

module.exports = createJestConfig(customJestConfig);

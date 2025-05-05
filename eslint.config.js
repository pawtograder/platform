import { FlatCompat } from "@eslint/eslintrc";
import globals from "globals";
import tseslint from "typescript-eslint";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname ?? __dirname // Fallback for older Node versions
});

const eslintConfig = [
  ...tseslint.configs.recommended,
  ...compat.config({
    extends: [
      "next",
      "prettier" // Disables ESLint formatting rules that conflict with Prettier
    ]
  }),

  // Custom Configurations and Overrides
  {
    languageOptions: { globals: { ...globals.browser }, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      // Custom Rules:
      "no-console": "warn"
    }
  }
];

export default eslintConfig;

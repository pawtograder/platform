// Typed lint pass for the bug reporter's `pii/pii-render` rule (eslint-rules/pii-render.js).
//
// Kept out of eslint.config.mjs on purpose: the rule needs the type checker, and building the
// program for the whole app roughly doubles `next lint`. `npm run lint:pii` runs this config
// through scripts/bugReport/piiLintRatchet.mjs, which fails only when the violation count rises
// above eslint-rules/pii-baseline.json. Only this rule runs here, in warn mode.
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import pii from "./eslint-rules/index.js";

export const PII_LINT_FILES = ["app/**/*.tsx", "components/**/*.tsx", "hooks/**/*.tsx", "lib/**/*.tsx"];

export default [
  {
    files: PII_LINT_FILES,
    // Disable directives here name rules this pass does not load; they are the main lint's business.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true }
      }
    },
    // Registered with every rule off, so disable comments that name their rules still resolve.
    plugins: { pii, "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks, "@next/next": nextPlugin },
    rules: { "pii/pii-render": "warn" }
  }
];

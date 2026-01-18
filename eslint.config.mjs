import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const eslintConfig = [
  ...compat.config({ extends: ["next/core-web-vitals", "next/typescript", "prettier"] }),
  {
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "no-console": "off" }
  }
];

export default eslintConfig;

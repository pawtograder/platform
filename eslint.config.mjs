import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

// Bans hard-coded light-palette backgrounds paired with white foregrounds — the exact
// pattern that produced the WCAG 1.4.3 violations surfaced by the a11y audit on PR #732.
// Use `colorPalette="<hue>" variant="solid"` instead so theme tokens (bumped to .700
// for AA contrast) drive the pairing centrally.
const PALETTE_SHADE_RE = "^(green|red|blue|orange|yellow|teal|pink|purple)\\.[3-6]00$";
const FORBIDDEN_PALETTE_BG_WITH_WHITE =
  "JSXOpeningElement:has(JSXAttribute[name.name='bg'][value.value=/" +
  PALETTE_SHADE_RE +
  "/]):has(JSXAttribute[name.name='color'][value.value='white'])";

// Bans `e instanceof Error ? e.message : "Unknown error"` and its "An unexpected error occurred"
// variant. refine and supabase-js reject with plain PostgREST objects, so this pattern hides the
// real reason (#983). Use getUserFacingErrorMessage from lib/studentFacingErrorMessages instead.
const GENERIC_ERROR_FALLBACK =
  "ConditionalExpression[test.operator='instanceof'][test.right.name='Error'][alternate.type='Literal'][alternate.value=/^(Unknown error|An unexpected error occurred)/]";

const eslintConfig = [
  // design-sync inputs are tooling artifacts (esbuild-compiled, never imported by
  // the app, regenerated each sync, intentionally full of `any`/mock shims).
  { ignores: [".design-sync/**", ".next-sso-e2e/**"] },
  ...compat.config({ extends: ["next/core-web-vitals", "next/typescript", "prettier"] }),
  {
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      "no-console": "warn",
      // Allow the conventional leading-underscore marker for deliberately-unused bindings
      // (e.g. interface-required parameters a fake/stub implementation ignores). Matches
      // `deno lint`'s default and keeps `npx eslint` clean over supabase/functions too.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: FORBIDDEN_PALETTE_BG_WITH_WHITE,
          message:
            'Don\'t pair a raw `bg="<palette>.500|600|…"` with `color="white"` — it bypasses the theme and typically fails WCAG 1.4.3 (e.g. green.600 + white = 3.29:1). Use `colorPalette="<hue>" variant="solid"` so the AA-bumped solid/contrast tokens apply.'
        },
        {
          selector: GENERIC_ERROR_FALLBACK,
          message:
            'This hides PostgREST errors, which are plain objects, not Errors (#983). Use getUserFacingErrorMessage(error) from "@/lib/studentFacingErrorMessages".'
        }
      ]
    }
  }
];

export default eslintConfig;

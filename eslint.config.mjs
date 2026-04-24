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

const eslintConfig = [
  ...compat.config({ extends: ["next/core-web-vitals", "next/typescript", "prettier"] }),
  {
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      "no-console": "warn",
      "no-restricted-syntax": [
        "error",
        {
          selector: FORBIDDEN_PALETTE_BG_WITH_WHITE,
          message:
            'Don\'t pair a raw `bg="<palette>.500|600|…"` with `color="white"` — it bypasses the theme and typically fails WCAG 1.4.3 (e.g. green.600 + white = 3.29:1). Use `colorPalette="<hue>" variant="solid"` so the AA-bumped solid/contrast tokens apply.'
        }
      ]
    }
  }
];

export default eslintConfig;

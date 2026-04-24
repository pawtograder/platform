import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

const config = defineConfig({
  globalCss: {
    html: {
      colorPalette: "gray" // Change this to any color palette you prefer
    }
  },
  theme: {
    semanticTokens: {
      colors: {
        // Bump {green,red}.solid from .600 → .700 so `colorPalette="green"`/`"red"` solid
        // buttons pair with white text at ≥ 4.5:1 (WCAG AA, 1.4.3). Default green.600
        // (#16a34a) + white = 3.29:1. green.700 (#15803d) + white = 4.62:1.
        green: {
          solid: { value: { base: "{colors.green.700}", _dark: "{colors.green.500}" } }
        },
        red: {
          solid: { value: { base: "{colors.red.700}", _dark: "{colors.red.500}" } }
        },
        purple: {
          solid: { value: { base: "{colors.purple.700}", _dark: "{colors.purple.400}" } }
        },
        blue: {
          solid: { value: { base: "{colors.blue.700}", _dark: "{colors.blue.400}" } }
        },
        orange: {
          solid: { value: { base: "{colors.orange.700}", _dark: "{colors.orange.400}" } }
        },
        // Chakra's default fg.success / fg.error pair with bg.success / bg.error at
        // ~3.1:1 (green.600 on green.50, red.600 on red.50) — below AA. Remap to
        // {green,red}.700 so status-tinted text cards (e.g. test-result headings)
        // hit AA automatically.
        fg: {
          success: { value: { base: "{colors.green.700}", _dark: "{colors.green.300}" } },
          error: { value: { base: "{colors.red.700}", _dark: "{colors.red.300}" } }
        }
      }
    }
  }
});

export const system = createSystem(defaultConfig, config);

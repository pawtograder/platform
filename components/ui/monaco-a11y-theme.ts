/**
 * WCAG AA syntax themes for the Monaco code viewer.
 *
 * Monaco's bundled `vs` and `vs-dark` themes predate 1.4.3 and ship several
 * token colors below 4.5:1 against their own editor background. Students read
 * their submitted code in this viewer, so those tokens are body text: the
 * student a11y sweep found `.mtk7` (the `comment` token, #608B4E on #1E1E1E =
 * 4.21:1) failing on the submission-files route (#905).
 *
 * Rather than patch one token, every rule in both bundled themes was measured
 * against its editor background and the ones below AA are corrected here. Each
 * correction keeps the original hue and saturation and moves lightness only as
 * far as it takes to reach ~5:1 — the extra half-point over the 4.5 threshold is
 * headroom for the line-highlight and annotation backgrounds this viewer paints
 * behind code (`monaco-line-highlight`, review-comment view zones), which shift
 * the effective backdrop away from the theme's own background color.
 *
 * `inherit: true` means these are the bundled themes with the listed rules
 * replaced; nothing else about them changes.
 *
 * Adopting this in another editor is one line in its `beforeMount`:
 * `registerAccessibleMonacoThemes(monaco)`, then use `accessibleMonacoTheme()`
 * for the `theme` prop. Registration is global to the Monaco singleton but must
 * still run before any editor asks for the theme by name.
 */
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

export const ACCESSIBLE_MONACO_LIGHT = "pawtograder-light";
export const ACCESSIBLE_MONACO_DARK = "pawtograder-dark";

/** Theme name for a Chakra color mode. */
export function accessibleMonacoTheme(colorMode: string | undefined): string {
  return colorMode === "dark" ? ACCESSIBLE_MONACO_DARK : ACCESSIBLE_MONACO_LIGHT;
}

/**
 * Token rules from `vs-dark` that fail AA on its #1E1E1E background, with the
 * measured before → after ratio.
 */
const DARK_RULES: editor.ITokenThemeRule[] = [
  { token: "variable.predefined", foreground: "758CC5" }, // #4864AA 2.92 -> 5.01
  { token: "comment", foreground: "6A9956" }, // #608B4E 4.21 -> 5.00
  { token: "regexp", foreground: "BD77A1" }, // #B46695 4.19 -> 5.01
  { token: "annotation", foreground: "D07272" }, // #CC6666 4.49 -> 5.03
  { token: "delimiter.html", foreground: "8D8D8D" }, // #808080 4.22 -> 5.02
  { token: "delimiter.xml", foreground: "8D8D8D" }, // #808080 4.22 -> 5.02
  { token: "tag.id.pug", foreground: "6E8FBC" }, // #4F76AC 3.59 -> 5.02
  { token: "tag.class.pug", foreground: "6E8FBC" }, // #4F76AC 3.59 -> 5.02
  { token: "string.sql", foreground: "FF4949" } // #FF0000 4.17 -> 5.00
];

/** The same, for `vs` on its #FFFFFE background. */
const LIGHT_RULES: editor.ITokenThemeRule[] = [
  { token: "annotation", foreground: "6F6F6F" }, // #808080 3.95 -> 5.02
  { token: "metatag.content.html", foreground: "E00000" }, // #FF0000 4.00 -> 5.03
  { token: "metatag.html", foreground: "6F6F6F" }, // #808080 3.95 -> 5.02
  { token: "metatag.xml", foreground: "6F6F6F" }, // #808080 3.95 -> 5.02
  { token: "attribute.name", foreground: "E00000" }, // #FF0000 4.00 -> 5.03
  { token: "string.sql", foreground: "E00000" }, // #FF0000 4.00 -> 5.03
  { token: "operator.sql", foreground: "617181" } // #778899 3.64 -> 5.01
];

/**
 * Define both themes on the Monaco singleton. Safe to call repeatedly —
 * `defineTheme` replaces a definition of the same name.
 */
export function registerAccessibleMonacoThemes(monaco: Monaco): void {
  monaco.editor.defineTheme(ACCESSIBLE_MONACO_LIGHT, { base: "vs", inherit: true, rules: LIGHT_RULES, colors: {} });
  monaco.editor.defineTheme(ACCESSIBLE_MONACO_DARK, { base: "vs-dark", inherit: true, rules: DARK_RULES, colors: {} });
}

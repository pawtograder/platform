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
 * far as it takes to reach ~5:1, half a point of margin over the 4.5 threshold.
 *
 * That margin is for rounding, NOT for anything the viewer paints behind code.
 * A translucent overlay swamps it: the old 30% yellow line highlight put every
 * dark token at ~2:1 regardless of this file, which is why it is now a left
 * rail (see {@link lineHighlightRail}). Any future backdrop has to leave the
 * code background alone for the same reason — keeping tokens at AA under a
 * yellow wash needs an alpha of 0.04 or less, which is invisible.
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
 * Color of the left rail that marks the line `scrollToLine` just jumped to.
 *
 * This used to be a 30% yellow fill across the whole line. A fill sits behind
 * the code, so it decided the contrast of every token on the one line the
 * reader had just been sent to: 2.05:1 for the corrected dark tokens, 2.31:1
 * for `keyword`, 4.60:1 even for plain editor text, and 4.29:1 for the light
 * `number` token (WCAG 1.4.3 wants 4.5:1). Lowering the alpha does not rescue
 * it — the ceiling is 0.04 dark / 0.08 light, which nobody would see.
 *
 * A rail carries the same "you are here" meaning without touching the code
 * background. It is also the first version of this cue that is visible in light
 * mode: the old fill measured 1.07:1 against the light editor background,
 * against the 3:1 that 1.4.11 asks of a state indicator. These two clear it
 * comfortably — yellow.300 is 12.65:1 on #1E1E1E, yellow.700 is 4.92:1 on
 * #FFFFFE.
 */
export function lineHighlightRail(colorMode: string | undefined): string {
  return colorMode === "dark" ? "#FDE047" : "#A16207";
}

/**
 * Token rules from `vs-dark` that fail AA on its #1E1E1E background, with the
 * measured before -> after ratio.
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

/** Registration is global to the Monaco singleton, so it only has to happen once. */
let registered = false;

/**
 * Define both themes on the Monaco singleton. Safe to call repeatedly, and now
 * cheap to: `defineTheme` ends with `if (this._theme.themeName === themeName)
 * this.setTheme(themeName)`, so redefining the theme an editor is already using
 * re-resolves it and re-broadcasts a color-theme change to every mounted editor.
 * The rules are static constants, so a second call can never produce a different
 * result — skip it.
 */
export function registerAccessibleMonacoThemes(monaco: Monaco): void {
  if (registered) return;
  registered = true;
  monaco.editor.defineTheme(ACCESSIBLE_MONACO_LIGHT, { base: "vs", inherit: true, rules: LIGHT_RULES, colors: {} });
  monaco.editor.defineTheme(ACCESSIBLE_MONACO_DARK, { base: "vs-dark", inherit: true, rules: DARK_RULES, colors: {} });
}

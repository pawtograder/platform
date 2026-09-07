/**
 * SurveyJS themes used across the app, with the light theme's primary fill
 * corrected for WCAG AA.
 *
 * `DefaultLight` pairs `--sjs-primary-backcolor` (SurveyJS brand teal
 * #19B394) with a white `--sjs-primary-forecolor`, which measures 2.65:1 —
 * well under the 4.5:1 that 1.4.3 asks of the label on a Complete/Next button.
 * That is the finding the student sweep recorded as `.sd-btn` on the
 * survey-taking and public-poll routes (#905), and it was the "low-contrast
 * palette" the old scan exclusion conceded rather than fixed.
 *
 * The fix darkens the teal instead of lightening the text, because the text is
 * already white: same hue and saturation, lightness reduced until white clears
 * 5:1 (the half-point over the threshold is headroom for the translucent
 * overlays SurveyJS paints on hover and focus). `--sjs-primary-backcolor-dark`
 * is the hover shade and keeps its original lightness gap below the base
 * color; `--sjs-primary-backcolor-light` is a 10% tint used as a background,
 * so it only tracks the new hue.
 *
 * `DefaultDark` is re-exported unchanged: its primary fill is orange #FF9814
 * with a near-black forecolor, which already clears AA. Darkening it would make
 * that pairing worse, so this correction is light-mode only.
 *
 * Only the primary ramp is changed. The `--sjs-special-*` fills carry white
 * forecolors with the same weakness, but nothing on the scanned student surface
 * renders them, so they are left to whatever a future finding proves about them
 * rather than changed blind.
 */
import { DefaultDark, DefaultLight } from "survey-core/themes";

/** #117D68 — 5.05:1 against white. Base was #19B394 at 2.65:1. */
const PRIMARY = "rgba(17, 125, 104, 1)";
/** #0F6C59 — 6.35:1. Hover shade, same lightness gap below PRIMARY as before. */
const PRIMARY_HOVER = "rgba(15, 108, 89, 1)";
/** 10% tint, used as a background rather than behind text. */
const PRIMARY_TINT = "rgba(17, 125, 104, 0.1)";

export const AccessibleLight = {
  ...DefaultLight,
  cssVariables: {
    ...DefaultLight.cssVariables,
    "--sjs-primary-backcolor": PRIMARY,
    "--sjs-primary-backcolor-dark": PRIMARY_HOVER,
    "--sjs-primary-backcolor-light": PRIMARY_TINT
  }
};

export { DefaultDark as AccessibleDark };

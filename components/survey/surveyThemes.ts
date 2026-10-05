/**
 * SurveyJS themes used across the app, with the light theme's primary fill and
 * both themes' error red corrected for WCAG AA.
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
 * `DefaultDark`'s primary fill is orange #FF9814 with a near-black forecolor,
 * which already clears AA. Darkening it would make that pairing worse, so the
 * primary correction is light-mode only.
 *
 * `--sjs-special-red` is corrected in both themes. It colors the validation
 * message SurveyJS shows when a required question is left empty
 * (`.sd-error`), drawn on the same red at 10% (`--sjs-special-red-light`).
 * That pairing measures 3.98:1 in light (#E50A3E) and 3.63:1 in dark
 * (#FE4C6C), and only renders after an invalid submit, which is why a scan
 * at page load never sees it. The same method as the teal applies: same hue
 * and saturation, lightness moved until the text clears AA on its own tint,
 * darker in light and lighter in dark. Light mode keeps the teal's 5:1
 * headroom; dark mode stops at 4.52:1 so the red stays close to the original
 * instead of turning pink. The red is also the required-question asterisk and
 * the fill behind `--sjs-special-red-forecolor` on danger buttons, and the
 * move improves both (dark danger buttons go from 4.06:1 to 5.28:1).
 *
 * The other `--sjs-special-*` fills carry white forecolors with the same
 * weakness, but nothing on the scanned student surface renders them, so they
 * are left to whatever a future finding proves about them rather than changed
 * blind.
 */
import { DefaultDark, DefaultLight } from "survey-core/themes";

/** #117D68 — 5.05:1 against white. Base was #19B394 at 2.65:1. */
const PRIMARY = "rgba(17, 125, 104, 1)";
/** #0F6C59 — 6.35:1. Hover shade, same lightness gap below PRIMARY as before. */
const PRIMARY_HOVER = "rgba(15, 108, 89, 1)";
/** 10% tint, used as a background rather than behind text. */
const PRIMARY_TINT = "rgba(17, 125, 104, 0.1)";

/** #C50935 — 5.06:1 on its 10% tint over white. Base was #E50A3E at 3.98:1. */
const RED_LIGHT_MODE = "rgba(197, 9, 53, 1)";
/** #FE7A91 — 4.52:1 on its 10% tint over #303030. Base was #FE4C6C at 3.63:1. */
const RED_DARK_MODE = "rgba(254, 122, 145, 1)";

export const AccessibleLight = {
  ...DefaultLight,
  cssVariables: {
    ...DefaultLight.cssVariables,
    "--sjs-primary-backcolor": PRIMARY,
    "--sjs-primary-backcolor-dark": PRIMARY_HOVER,
    "--sjs-primary-backcolor-light": PRIMARY_TINT,
    "--sjs-special-red": RED_LIGHT_MODE,
    "--sjs-special-red-light": "rgba(197, 9, 53, 0.1)"
  }
};

export const AccessibleDark = {
  ...DefaultDark,
  cssVariables: {
    ...DefaultDark.cssVariables,
    "--sjs-special-red": RED_DARK_MODE,
    "--sjs-special-red-light": "rgba(254, 122, 145, 0.1)"
  }
};

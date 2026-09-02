# Custom branding assets (baked into the image)

Files placed in this directory are served at `/branding/<filename>` and are
copied into the published web image by the `Dockerfile` (`COPY public ./public`).
This is the recommended way to **"burn" custom logos and a favicon into a
self-hosted image** instead of hosting them on an external URL.

## How to use

1. Drop your assets here before building the web image, e.g.:
   - `public/branding/logo-light.png` — logo for light mode (square works best)
   - `public/branding/logo-dark.png` — logo for dark mode
   - `public/branding/favicon.png` — browser-tab icon (PNG, SVG, or ICO)
2. Build the image (`docker build ...`). Anything under `public/` ships inside it.
3. Point the deployment chart's `web.branding.*` values at the bundled paths:

   ```yaml
   web:
     branding:
       name: "TartanGrader"
       logoLight: "/branding/logo-light.png"
       logoDark: "/branding/logo-dark.png"
       favicon: "/branding/favicon.png"
       colorPalette: "red"
   ```

Because branding is read from plain server-side env vars at request time
(`lib/branding.ts`), the same image can still be re-skinned per deployment — the
assets just need to exist in the image. Leaving a `web.branding.*` value blank
keeps the built-in Pawtograder default for it.

The `tartangrader-*` files in this directory are a worked example of the above
(a Carnegie-Mellon-flavored "TartanGrader" skin); they are referenced by
[`examples/values-tartangrader.yaml`](../../charts/pawtograder/examples/values-tartangrader.yaml).

# design-sync notes — Pawtograder

Repo-specific gotchas for future syncs. Append as you learn things.

## Repo shape

- This is a **Next.js app** (`@pawtograder/webapp`), not a published component library. There is **no built `dist/`** of components (the repo's `dist/` is k6 load tests). So the converter runs in **package shape via a hand-written entry barrel**, not synth-from-srcDir.
  - `.design-sync/ds-entry.tsx` re-exports ONLY the scoped primitives. Pass it with `--entry ./.design-sync/ds-entry.tsx`. Without it, synth-entry would `export *` every file under `components/` and pull the entire app (monaco, supabase, refine) into one bundle.
  - `componentSrcMap` in config lists the card names (real Chakra export names — `DialogRoot`, `SelectRoot`, etc.) pinned to their src files. `export *` in the barrel keeps all compound sub-parts (`DialogContent`, `MenuItem`, …) in the bundle so previews can compose them.
- `--node-modules ./node_modules` (repo root — that's where `react` resolves).
- `cfg.tsconfig` = `./tsconfig.json` so the `@/* → ./*` path alias resolves in the bundle.

## Provider

- The app's real `components/ui/provider.tsx` wraps `ChakraProvider` in **Refine + Supabase** — unusable in previews. `.design-sync/preview-provider.tsx` exports `PreviewProvider` = just `ChakraProvider value={system}` (the theme from `components/ui/theme.ts`). Wired via `cfg.provider` + `cfg.extraEntries`.

## Styling

- **Chakra v3 + emotion = CSS-in-JS**: styles inject at runtime via the provider. `[CSS_RUNTIME]` is EXPECTED and non-blocking — there is no static stylesheet to ship; the bundle is self-styling. Do not chase it, do not set `cfg.cssEntry`.

## Scope exclusions

- `components/ui/` mixes idioms. 5 files use **Tailwind/cva (shadcn)** — `badge`, `label`, `dropdown-menu`, `md-editor`, `message-input`. Their `--primary`/`--ring` CSS custom props are NOT defined in `app/globals.css` (vestigial), so they'd render unstyled. **Excluded.** To include later, compile the Tailwind CSS and set `cfg.cssEntry`.
- Default-export, data-bound app pieces excluded: `tag` (TagDisplay needs TagType), `link` (next/link wrapper), `markdown`, `person-avatar`/`person-name` (need a uid + live data).

## Toolchain

- Render check (playwright): repo pins `@playwright/test ^1.54.1` but `node_modules/playwright-core` is **1.59.1 → chromium 1217 (NOT cached)**. The chromium cache has builds **1181 (pw 1.54.x)** and **1187 (pw 1.55.0)**. Installed **playwright@1.55.0** into `.ds-sync` so the render check uses cached chromium 1187 — no download.

## Component-authoring learnings (from preview fan-out)

- **Overlays render open inline**: pass `open` to the Root + `portalled={false}` to the content part (DialogContent/DrawerContent/PopoverContent/MenuContent/SelectContent, Tooltip/ToggleTip `portalled`). Configured `cardMode: single` for all overlays in `cfg.overrides`. This pattern works for Dialog, Drawer, Popover, Menu, Tooltip, ToggleTip, Select.
- **SelectRoot** (Chakra v3): build `createListCollection({items:[{label,value}]})`, pass `collection` + `defaultValue` + `open` to SelectRoot, `portalled={false}` to SelectContent; wrap open cell in `Box minH=...` for room. Renders the open dropdown with a check on the selected item.
- **DataListItem** takes `label`/`value`/`info` props directly — do NOT compose DataListItemLabel/Value.
- **RadioCardItem** takes `label`/`description`/`value` props directly.
- **ResponsiveTable**: `Box overflowX=auto` + `Table.Root`; props `tableMinW`, `rootProps` (e.g. `striped`), `wrapperProps`; compose with `Table.*` parts.
- **AvatarGroup**: overlap group; overflow `+N` is just another Avatar with that name.

## Skips / known limitations

- **SubmitButton — SKIPPED preview (floor card).** Its source imports `useFormStatus` from `react-dom` (a React 19 API). The repo + bundle are on **react-dom 18.3.0**, which doesn't export it → throws on every render. `cfg.overrides.SubmitButton.skip = true`. The component still ships in the bundle (`.d.ts` documents its API); it will render only in a host that provides `useFormStatus` + a form context. To author its preview later: upgrade react/react-dom to 19, or shim `useFormStatus`.
- **PopConfirm** controls `open` via internal `useState` — no `open`/`defaultOpen` prop, so it can't be force-opened. The preview faithfully **reproduces its open composition** (PopoverRoot open + header/body + ghost-X/solid-check IconButtons) — visually matches. If a literal-component card is ever required, add a controllable open prop to the source.
- **TypographyInlineCode** styles its pill via Tailwind utilities (`bg-muted`, `font-mono`) that aren't in the Chakra build → renders as plain monospace text, no background. Graded good (it's the component's actual behavior here). For a styled pill, the component would need Chakra `Code`/tokens instead of Tailwind.
- **DrawerRoot**: right-anchored panel clips a few px at the iframe right edge (cosmetic); structure fully readable.

## Claude Design access

- First sync needed claude.ai login re-auth to gain design-system access (`user:design:read/write`). A `/design-login` scope grant alone wasn't enough — a full `/login` re-auth upgraded the token. If a future sync 403s with "access gate closed", re-run `/login`.
- **Uploaded to project `afef41b8-504e-4c01-84ca-2e70b2e6159c`** ("Pawtograder Design System") — https://claude.ai/design/p/afef41b8-504e-4c01-84ca-2e70b2e6159c. `projectId` is pinned in config.json so re-syncs fetch the anchor automatically.

## Re-sync cleanup candidates

- **guidelines/** currently ships repo DEV docs (lti-1.3-integration, lti-section-mapping, metrics, seed-course-assignments) picked up by the default `guidelinesGlob` (`docs/*.md`). These are not design guidelines and are noise for the design agent. To drop them, set `cfg.guidelinesGlob` to `[]` (or a real design-guides path) and rebuild.

## Wave 2 — complex components (added groups A/B/C/D)

- **Rubric editor suite** (`RubricGuiEditor`, `RubricEditorTree`, `RubricHeaderForm`, `PartCard`, `CriterionCard`, `CheckRow`, `SortableList`) is driven by a shared fixture `.design-sync/previews/_rubricFixture.ts` (a `HydratedRubric` carrying only the fields the editors read, cast `as any`). RubricGuiEditor/Tree render the whole nested tree from it. If a rubric editor changes which fields it reads, extend the fixture (the render error names the missing field). These got grouped under `rubric-editor/` (from src path).
- **Charts** (`AnalyticsChart`, recharts) and **survey-core** components (`SurveyBuilder`, `AnalyticsConfigEditor`) render statically fine — survey-core `Model` parses a survey-JSON string without DOM/async issues. The bundle grew to ~7MB from these heavy deps (recharts, survey-core, dnd-kit, react-markdown) — expected, fine for the design tool.
- **Overlays/wide** added to `cfg.overrides`: CommandPalette (single), AnalyticsChart/RubricGuiEditor/RubricEditorTree/PartCard/CriterionCard/SurveyBuilder/GradeLedgerHeader/AppRouteLoadingSkeleton (column).
- **`TimeZoneAwareDate` content is REDACTED by the capture harness** (it carries `data-visual-test="transparent"`, the determinism marker for timestamps) — it blanks the whole cell, not just the date. Any component whose visible content is solely a `TimeZoneAwareDate` will capture blank. Fix for `DueDateDisplay`: pass a plain `dueDateNode={<Text>Mar 18, 11:59 PM</Text>}` instead of `dueDate=...` (and avoid `suggestedDueDate`, which also uses TimeZoneAwareDate). Same trick applies to any future date-bearing component.
- **Default-export components** are surfaced via explicit `export { default as Name }` in `ds-entry.tsx` (export * does not carry defaults). componentSrcMap maps the card name → src file.
- **StatusCell** is one card from `InstructorRegradeTableShared.tsx` (which exports several cells); statuses: draft/opened/resolved/escalated/closed.

## ⚠️ REQUIRED before every build: enable minify

The bundle now inlines survey-core + recharts + dnd-kit + react-markdown. **Unminified it is ~6.9MB, which EXCEEDS the DesignSync 5MB per-file upload limit** (`write_files: file at localPath exceeds the 5242880 byte limit`). Minified it is **~3.2MB**.

The converter ships with `minify: false` hardcoded in `lib/bundle.mjs` (line ~182) and there is no config flag. So **after `cp -r`-ing the staged scripts each sync, edit `.ds-sync/lib/bundle.mjs`: change `minify: false` → `minify: true`** before building. This is safe: the `@ds-bundle` header the app self-check reads is *prepended post-build* by `stampHeader` (writeFileSync), so minification never strips it; exports and the IIFE global are unchanged. Verified: render check 52/52 clean with the minified bundle.

(`.ds-sync/` is gitignored and re-copied from the skill each run, so this edit does NOT persist — re-apply it every sync. If a future converter adds a minify config key, use that instead.)

## Re-sync cleanup candidates (added)

- The `_rubricFixture.ts` is tied to the current rubric editor field reads — a re-sync risk if those components change. The render error will name any new required field.

## Parked: grading interface (rubric-sidebar + code-file-plain)

Attempted to add the live grading UI. **The mock data layer WORKS** — `RubricSidebar` and `CodeFilePlain` render offline from mocks (RubricSidebar shows real rubric content). But the attempt is **PARKED, not shipped**, for one decisive reason: **the transitive closure bundles to ~14MB minified, far over the 5MB DesignSync upload limit**, and it can't be trimmed cleanly.

What's on disk (parked, not wired into the active build):
- `.design-sync/mocks/` — 14 mock modules replacing the app's data layer (useSubmission, useAssignment, useCourseController, useClassProfiles, useSubmissionReview, useUserProfiles, useRubricVisibility, useRubricAnnotationActions, useNextIncompleteReview, useMentions, TableController, refine, supabase-client, next-navigation) + `fixtures.ts` (canned submission/rubric/comments/profiles) + `_lib.ts` (mockTable, inertProxy) + `_globals.ts` (process shim) + stubs (path, next-dynamic, next-image, stub-empty for monaco/sentry, useUserPreferences, useSubmissionFileSymbols).
- `.design-sync/tsconfig.ds.json` — aliases the app data-layer modules → the mocks (exact rules before `@/*`; baseUrl `..`).

To RE-ENABLE (only worth it if the size wall is solved):
1. In `ds-entry.tsx`: uncomment the two grading exports and re-add `import "./mocks/_globals"` as the FIRST line.
2. In `config.json`: set `cfg.tsconfig` → `./.design-sync/tsconfig.ds.json`; re-add RubricSidebar/CodeFilePlain to `componentSrcMap` + `overrides` (column mode).

Why it can't ship as-is, and what would be needed:
- **Size (14MB > 5MB).** rubric-sidebar/code-file-shared pull `MessageInput` (giphy, mentions, math/katex, discussion, polls) + the markdown apparatus. These heavy leaves are imported via **relative** specifiers (`./message-input` ×6, `./line-comments-form`, `./giphy-picker`), which the tsconfig-paths alias mechanism CANNOT remap (it only fires for `@/`-style and bare-package prefixes). Trimming them requires **forking the bundle step** (`lib/bundle.mjs` — a "don't fork" file) to add an esbuild onResolve alias plugin that stubs those relative imports. Even then it's uncertain it drops under 5MB.
- **Node globals.** The closure references `process` (shimmed via `_globals.ts`) and `path` (mocked); symptomatic of how server-coupled this code is.
- **Monaco** (`code-file-monaco`) is separately infeasible (offline CDN load + web workers + 28MB) — that's why only the non-Monaco `code-file-plain` was attempted.
- A leftover fixture bug to fix on resume: RubricSidebar threw `RangeError: Invalid time value` (a date field formatRelative'd a bad value — give every fixture date a valid ISO string, or the comment/review created_at the sidebar formats).

## Known render warns

- `[CSS_RUNTIME]` (styles.css has no @imports; _ds_bundle.css is the runtime stub) — expected, CSS-in-JS. Always present.
- `[RENDER_BLANK]`/floor card on **SubmitButton** — expected (skipped, see above).

## Re-sync risks

- If Chakra is upgraded (v3 → v4), the snippet APIs (`*Root`/`*Content` parts) may change — re-verify compound previews.
- The bundle inlines ~95 npm packages from app source; a heavy new transitive import in any scoped component file could balloon the bundle or break esbuild. Re-check `bundle:` KB on re-sync.
- `preview-provider.tsx` / `ds-entry.tsx` are tied to current `components/ui/` paths — a file move breaks the barrel.

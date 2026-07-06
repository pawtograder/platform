# Pawtograder design system — usage conventions

Built on **Chakra UI v3** (`@chakra-ui/react`) with a custom theme. Components are
re-exported from the app's `components/ui/` snippets. Everything renders through
`window.Pawtograder`.

## 1. Wrap every design in the provider

All components read the Chakra theme `system` from context. Without the provider they
render **unstyled** (browser defaults) or throw context errors. Wrap your design's root in
the exported `PreviewProvider` once:

```jsx
import { PreviewProvider, Button, Stack } from "@pawtograder/webapp";

export default function App() {
  return (
    <PreviewProvider>
      <Stack gap={4} p={6}>
        <Button colorPalette="green">Release grades</Button>
      </Stack>
    </PreviewProvider>
  );
}
```

`PreviewProvider` installs the Chakra `system` (tokens, fonts, semantic colors). It is the
only setup needed — no stylesheet import, because styles are injected at runtime
(CSS-in-JS / emotion).

## 2. Style with PROPS, not CSS classes

This is a Chakra v3 system: **there are no utility classes and no `className` design
language.** You style by passing props. Do NOT invent Tailwind/CSS classes — they won't
resolve.

- **Color intent:** `colorPalette` on interactive components. Values: `gray` (default),
  `green`, `red`, `blue`, `orange`, `purple`. The solid step is contrast-tuned for AA white
  text (e.g. `<Button colorPalette="green">`, `<Badge colorPalette="orange">`).
- **Variant / size:** `variant` (`solid` | `subtle` | `surface` | `outline` | `ghost` |
  `plain`) and `size` (`xs` | `sm` | `md` | `lg` | `xl`).
- **Status (Alert):** `status` = `info` | `success` | `warning` | `error`.
- **Layout:** compose with `Stack` / `HStack` / `VStack` (`gap`, `justify`, `align`),
  `Box`, `Flex`, `SimpleGrid`, `Group`, `Separator`.
- **Spacing / sizing props:** `p`, `px`, `py`, `m`, `gap`, `w`, `h`, `minH` — use the token
  scale (numbers map to the spacing scale, e.g. `p={4}`).
- **Color tokens:** `color` / `bg` take semantic tokens, e.g. `color="fg.muted"`,
  `color="fg.success"`, `color="fg.error"`, `bg="bg.subtle"`. Prefer semantic tokens over
  raw hex so light/dark both work.

## 3. Compound components use sub-parts

Overlays and structured components are composed from named sub-parts (the Chakra v3 idiom):

- **Dialog:** `DialogRoot` › `DialogContent` › `DialogHeader`/`DialogTitle`,
  `DialogBody`, `DialogFooter`, `DialogCloseTrigger`. Drive open state with `open` on the
  root. (`DrawerRoot`, `PopoverRoot`, `MenuRoot` follow the same Root/Content/parts shape.)
- **Select:** build a collection with `createListCollection({ items: [{ label, value }] })`,
  pass it as `collection` to `SelectRoot`, then `SelectTrigger` + `SelectValueText` +
  `SelectContent` + `SelectItem`.
- **Field** is a wrapper (NOT a `Field.Root` namespace here): `<Field label="…"
  helperText="…" errorText="…" invalid required>{<Input/>}</Field>`.
- **DataList:** `DataListRoot` (`orientation`, `size`) › `DataListItem label="…" value="…"`.
- **RadioCard:** `RadioCardRoot` › `RadioCardItem label="…" description="…" value="…"`.

## 4. Where the real definitions live

Read the per-component docs and prop contracts under
`_ds/<folder>/components/<group>/<Name>/` (`<Name>.d.ts` is the API contract,
`<Name>.prompt.md` the usage notes). The theme tokens come from the Chakra `system`.

## Note

`SubmitButton` requires React 19's `useFormStatus` + a `<form action>` context — it ships
in the bundle but renders only inside a form. `TypographyInlineCode` renders plain
monospace text (its pill styling relied on Tailwind utilities not present in this build);
for an inline-code pill, prefer the Chakra `Code` primitive.

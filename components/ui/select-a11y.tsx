"use client";

import { chakra, Span } from "@chakra-ui/react";
import type { GroupBase, MultiValueRemoveProps, SelectComponentsConfig } from "chakra-react-select";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Accessible replacement for chakra-react-select's `MultiValueRemove`.
 *
 * The stock component splits the role and the name across two elements
 * (chakra-react-select 6.1.0):
 *
 *   <span {...innerProps}>          // carries aria-label="Remove X", no role
 *     <span role="button">          // has the role, no accessible name
 *       <CloseIcon />
 *
 * so every chip trips two 4.1.2 rules at once — `aria-prohibited-attr` on the
 * outer span, because `aria-label` is not allowed on a generic element, and
 * `aria-command-name` on the inner one, because a `button` role with no text,
 * `aria-label`, `aria-labelledby` or `title` has no name (#909).
 *
 * The fix puts both on the same element, and makes that element a real
 * `<button>` rather than a span wearing a role. `innerProps` carries the
 * aria-label and the pointer handlers, so moving it inward is what joins the
 * name to the role. As a side effect the control becomes focusable and
 * Enter/Space-operable, which the span never was — react-select's own Backspace
 * shortcut was previously the only keyboard route to removing a chip.
 *
 * The wrapper span stays: it holds the library's `endElementCss` positioning,
 * and dropping it would change chip layout.
 */
export function AccessibleMultiValueRemove<
  Option = unknown,
  IsMulti extends boolean = boolean,
  Group extends GroupBase<Option> = GroupBase<Option>
>(props: MultiValueRemoveProps<Option, IsMulti, Group>) {
  const { children, innerProps, isFocused, endElementCss, css, selectProps } = props;
  // react-select types `innerProps` for the div it expects to be spread onto.
  // What it actually carries — aria-label, onClick, onTouchEnd, onMouseDown,
  // className — is valid on a button, so the cast is a typing detail rather
  // than a behavioral one.
  const buttonProps = innerProps as ComponentPropsWithoutRef<"button">;
  // A real <button> is focusable and Enter-operable, which the stock span was
  // not — so on a disabled select it would become a live control the keyboard
  // can still reach. chakra-react-select only guards the Control with
  // `pointerEvents: none` (mouse-only) and react-select builds `removeProps`
  // unconditionally, so the disabled state has to be carried here.
  const isDisabled = Boolean(selectProps?.isDisabled);
  return (
    <Span css={endElementCss}>
      <chakra.button
        type="button"
        css={css}
        disabled={isDisabled}
        data-focus-visible={isFocused ? true : undefined}
        {...buttonProps}
      >
        {children ?? <CloseIcon />}
      </chakra.button>
    </Span>
  );
}

/** The library's own close glyph, which is not exported. */
function CloseIcon() {
  return (
    <chakra.svg viewBox="0 0 24 24" fill="currentColor" boxSize="1em" aria-hidden="true" focusable="false">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M18.7071 6.70711C19.0976 6.31658 19.0976 5.68342 18.7071 5.29289C18.3166 4.90237 17.6834 4.90237 17.2929 5.29289L12 10.5858L6.70711 5.29289C6.31658 4.90237 5.68342 4.90237 5.29289 5.29289C4.90237 5.68342 4.90237 6.31658 5.29289 6.70711L10.5858 12L5.29289 17.2929C4.90237 17.6834 4.90237 18.3166 5.29289 18.7071C5.68342 19.0976 6.31658 19.0976 6.70711 18.7071L12 13.4142L17.2929 18.7071C17.6834 19.0976 18.3166 19.0976 18.7071 18.7071C19.0976 18.3166 19.0976 17.6834 18.7071 17.2929L13.4142 12L18.7071 6.70711Z"
      />
    </chakra.svg>
  );
}

/**
 * Merge {@link AccessibleMultiValueRemove} into a `components` prop, keeping
 * whatever overrides a call site already passes. Only multi-selects render
 * chips, so it is a no-op elsewhere and safe to apply uniformly.
 *
 *   <Select isMulti components={accessibleSelectComponents()} ... />
 */
export function accessibleSelectComponents<
  Option = unknown,
  IsMulti extends boolean = boolean,
  Group extends GroupBase<Option> = GroupBase<Option>
>(components?: SelectComponentsConfig<Option, IsMulti, Group>): SelectComponentsConfig<Option, IsMulti, Group> {
  // Override first, caller last: spreading `components` second is what makes the
  // doc comment true — a call site that supplies its own MultiValueRemove keeps it.
  return { MultiValueRemove: AccessibleMultiValueRemove, ...components };
}

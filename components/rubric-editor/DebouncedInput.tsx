"use client";

import { Input, type InputProps, Textarea, type TextareaProps } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";

/**
 * Local-state input wrappers used by the rubric GUI editor.
 *
 * The text inputs in the rubric editor (criterion/check/part names, descriptions,
 * point counts) all sit inside a memoized tree whose `rubric` prop is rebuilt on
 * every commit. Pushing `e.target.value` straight up the chain on every keystroke
 * re-rendered the whole tree, sanitized the whole rubric, and re-ran validation —
 * which made typing feel sticky on larger rubrics.
 *
 * These wrappers keep the typed string in local component state and only call
 * `onCommit` on blur or after the user pauses typing for `commitDelayMs` (default
 * 500ms). Pending dirty edits are also flushed when the prop unmounts so swap
 * /reorder operations don't drop the user's keystrokes.
 *
 * External `value` updates from props are accepted while the input is not dirty,
 * so programmatic edits (e.g. switching review-round tabs, snapshot restores)
 * still flow through.
 */

const DEFAULT_COMMIT_DELAY_MS = 500;

type CommonBufferProps = {
  value: string;
  onCommit: (next: string) => void;
  /** Idle commit delay. Set to 0 to commit only on blur / unmount. */
  commitDelayMs?: number;
};

function useDebouncedInputBuffer({ value, onCommit, commitDelayMs = DEFAULT_COMMIT_DELAY_MS }: CommonBufferProps) {
  const [local, setLocal] = useState(value);
  const localRef = useRef(local);
  localRef.current = local;
  const isDirtyRef = useRef(false);
  const lastSyncedValueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Accept external prop changes only when the user isn't mid-edit; otherwise
  // we'd clobber what they just typed.
  useEffect(() => {
    if (!isDirtyRef.current && value !== lastSyncedValueRef.current) {
      lastSyncedValueRef.current = value;
      setLocal(value);
    }
  }, [value]);

  const flush = () => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = undefined;
    }
    if (!isDirtyRef.current) return;
    isDirtyRef.current = false;
    lastSyncedValueRef.current = localRef.current;
    onCommitRef.current(localRef.current);
  };

  // Capture-final-value-on-unmount so reordering or expand/collapse can't lose edits.
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (isDirtyRef.current) onCommitRef.current(localRef.current);
    };
  }, []);

  return {
    local,
    handleChange: (next: string) => {
      setLocal(next);
      isDirtyRef.current = next !== lastSyncedValueRef.current;
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (commitDelayMs > 0 && isDirtyRef.current) {
        idleTimerRef.current = setTimeout(flush, commitDelayMs);
      }
    },
    handleBlur: flush
  };
}

type DebouncedInputProps = Omit<InputProps, "value" | "onChange" | "onBlur"> & CommonBufferProps;

export function DebouncedInput({ value, onCommit, commitDelayMs, ...props }: DebouncedInputProps) {
  const { local, handleChange, handleBlur } = useDebouncedInputBuffer({ value, onCommit, commitDelayMs });
  return (
    <Input
      {...props}
      value={local}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={handleBlur}
    />
  );
}

type DebouncedTextareaProps = Omit<TextareaProps, "value" | "onChange" | "onBlur"> & CommonBufferProps;

export function DebouncedTextarea({ value, onCommit, commitDelayMs, ...props }: DebouncedTextareaProps) {
  const { local, handleChange, handleBlur } = useDebouncedInputBuffer({ value, onCommit, commitDelayMs });
  return (
    <Textarea
      {...props}
      value={local}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={handleBlur}
    />
  );
}

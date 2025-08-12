"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./button";

export interface SubmitButtonProps
  extends Omit<ButtonProps, "loading" | "loadingText" | "type"> {
  pendingText?: React.ReactNode;
  trackByName?: string;
  trackByValue?: string;
  name?: string;
  value?: string;
}

export function SubmitButton(props: SubmitButtonProps) {
  const formStatus = useFormStatus() as unknown as { pending: boolean; data?: FormData };
  const pending = formStatus?.pending ?? false;
  const data = formStatus?.data;

  const {
    children,
    pendingText,
    trackByName = "action",
    trackByValue,
    name,
    value,
    disabled,
    ...rest
  } = props;

  const isThisSubmit = React.useMemo(() => {
    if (!pending) return false;
    // If no name/value provided, assume this is the only submit in the form
    if (!name && !trackByValue) return true;
    // Inspect pending FormData if available to match the clicked submit
    if (!data) return true;
    const submittedName = name ?? trackByName;
    if (!submittedName) return true;
    const submittedValue = data.get(submittedName)?.toString();
    const targetValue = value ?? trackByValue;
    if (targetValue == null) return Boolean(submittedValue);
    return submittedValue === String(targetValue);
  }, [pending, data, name, value, trackByName, trackByValue]);

  return (
    <Button
      type="submit"
      loading={isThisSubmit}
      loadingText={pendingText}
      disabled={pending || disabled}
      {...rest}
      name={name}
      value={value}
    >
      {children}
    </Button>
  );
}

import { Field, Input, Stack } from "@pawtograder/webapp";

export const WithHelperText = () => (
  <Field label="Email" helperText="Use your @northeastern.edu address.">
    <Input placeholder="you@northeastern.edu" />
  </Field>
);

export const Required = () => (
  <Field label="Assignment title" required>
    <Input placeholder="Problem Set 3" />
  </Field>
);

export const Optional = () => (
  <Field label="Late penalty note" optionalText="(optional)">
    <Input placeholder="e.g. 10% per day" />
  </Field>
);

export const Invalid = () => (
  <Field label="Due date" invalid errorText="Due date must be in the future.">
    <Input defaultValue="2024-01-01" />
  </Field>
);

export const Disabled = () => (
  <Field label="Course term" disabled helperText="Locked after the term starts.">
    <Input defaultValue="Spring 2026" />
  </Field>
);

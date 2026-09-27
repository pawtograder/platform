/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
// next/dynamic stub: render a tiny placeholder instead of lazy-loading. The
// grading previews render code-file-plain directly, so the Monaco branch of
// code-file is never exercised.
export default function dynamic(_loader?: any, opts?: any): any {
  const Placeholder = () => (opts && opts.loading ? opts.loading() : React.createElement("div"));
  Placeholder.displayName = "DynamicStub";
  return Placeholder;
}

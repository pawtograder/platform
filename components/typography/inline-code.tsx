import type { ReactNode } from "react";

export default function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code
      className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold"
      data-visual-test-no-radius
    >
      {children}
    </code>
  );
}

// Named export for backward compatibility
export { InlineCode };

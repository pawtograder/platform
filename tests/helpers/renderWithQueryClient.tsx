import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, RenderOptions } from "@testing-library/react";
import { ReactElement } from "react";
import { createTestQueryClient } from "./createTestQueryClient";

/**
 * Render a React element wrapped in a QueryClientProvider.
 * Optionally accepts a pre-configured QueryClient for tests that need to
 * pre-seed or inspect the cache.
 */
export function renderWithQueryClient(
  ui: ReactElement,
  queryClient?: QueryClient,
  options?: Omit<RenderOptions, "wrapper">
) {
  const client = queryClient ?? createTestQueryClient();
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...render(ui, { wrapper: Wrapper, ...options }),
    queryClient: client
  };
}

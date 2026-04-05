import { QueryClient } from "@tanstack/react-query";

/**
 * Create a QueryClient configured for deterministic unit testing:
 * - retry disabled so failures surface immediately
 * - gcTime/staleTime set to Infinity so cache entries persist for the test's duration
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity
      },
      mutations: {
        retry: false
      }
    }
  });
}

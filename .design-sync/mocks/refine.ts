/* eslint-disable @typescript-eslint/no-explicit-any */
// Mock of @refinedev/core — the data hooks the grading components call. All
// mutations are inert; lists are empty. Enough for static render.
const mutation = { mutate: () => {}, mutateAsync: async () => ({ data: {} }), isLoading: false, isPending: false };
export function useUpdate(): any { return mutation; }
export function useCreate(): any { return mutation; }
export function useDelete(): any { return mutation; }
export function useList(): any { return { data: { data: [], total: 0 }, isLoading: false, isPending: false }; }
export function useInvalidate(): any { return async () => {}; }

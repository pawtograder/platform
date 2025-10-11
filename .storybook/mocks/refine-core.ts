export const Refine = ({ children }: { children: React.ReactNode }) => children as any;
export const useUpdate = () => ({ mutateAsync: async () => ({}) });
export const useInvalidate = () => (_args: any) => {};
export const useList = <T,>(_: any) => ({ data: { data: [] as T[] }, isLoading: false });
export const useCreate = () => ({ mutate: (_args: any, _opts?: any) => {} });
export const useDelete = () => ({ mutate: (_args: any, _opts?: any) => {} });
export const useShow = <T,>(_: any) => ({ query: { data: { data: {} as T }, isLoading: false, error: undefined } });

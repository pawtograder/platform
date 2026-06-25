/* eslint-disable @typescript-eslint/no-explicit-any */
// Mock of @/lib/TableController — only the hook/utility exports the grading
// components import. The real class is replaced by a no-op stand-in.
export class TableController {
  isReady = true;
  list() { return { unsubscribe: () => {}, data: [] as any[] }; }
  getById() { return { data: undefined, unsubscribe: () => {} }; }
  async create() {}
  async update() {}
  async delete() {}
  close() {}
}
export function useIsTableControllerReady(): boolean { return true; }
export function useTableControllerTableValues(controller?: any): any[] {
  return controller?.rows ?? [];
}
export function useListTableControllerValues(controller?: any): any[] {
  return controller?.rows ?? [];
}
export function useFindTableControllerValue(): any { return undefined; }

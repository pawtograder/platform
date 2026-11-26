export type ClassRole = { id: number; name: string; default_for: string | null };

export const heldKey = (roleId: number, capability: string) => `${roleId}:${capability}`;

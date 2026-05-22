export function valOrUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

export function valOrNull<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

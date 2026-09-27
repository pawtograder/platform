/**
 * Pass NULL to an RPC argument whose generated type does not admit it.
 *
 * `supabase gen types` types every function argument as non-null, but a plpgsql argument accepts
 * NULL and several of ours give it a meaning ("expect no pointer", "expect no config"). Omitting
 * the key or passing `undefined` is NOT equivalent: PostgREST then uses the argument's default, or
 * rejects the call. Hand-editing the generated file to say `| null` does not survive the next
 * regeneration, so the cast lives here, at the call sites that mean it.
 */
export function rpcNull<T>(value: T | null): T {
  return value as T;
}

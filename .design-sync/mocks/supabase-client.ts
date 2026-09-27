/* eslint-disable @typescript-eslint/no-explicit-any */
import { inertProxy } from "./_lib";
// Mock of @/utils/supabase/client — createClient returns an inert chainable
// proxy so any stray query during render is a harmless no-op (never called in
// the target components' render path, but safe if a sibling reaches for it).
export function createClient(): any { return inertProxy(); }

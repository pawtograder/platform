import type { WhatsNewEntry } from "./define";
import ohEscalation from "./entries/oh-escalation";

/**
 * Every What's New walkthrough, oldest first. <WhatsNew page="..." /> opens the first unseen one for
 * its page on its own, and its header button opens the newest one. Each id must also be in
 * WHATS_NEW_IDS (lib/whatsNew/ids.ts), which Node code reads.
 */
export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [ohEscalation];

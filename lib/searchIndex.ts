/**
 * Pure, framework-free search-index plumbing used by the global search
 * palette. Kept separate from the React hook so unit tests can import
 * filterSearchIndex without booting Chakra.
 */
export type SearchHitKind =
  | "page"
  | "assignment"
  | "survey"
  | "discussion"
  | "discussion-topic"
  | "help-queue"
  | "setting";

export type SearchHit = {
  id: string;
  kind: SearchHitKind;
  title: string;
  subtitle?: string;
  url: string;
  /** Extra strings searched alongside title/subtitle. */
  keywords?: string[];
  /**
   * Optional drill-down targets. When set, activating this hit in the palette
   * opens a nested chooser of these children instead of navigating directly.
   * Used for e.g. picking an assignment then selecting "Edit Rubric".
   */
  children?: SearchHit[];
};

export type SearchHitGroup = { kind: SearchHitKind; label: string; hits: SearchHit[] };

const PER_GROUP_CAP = 8;
const TOTAL_CAP = 40;

const GROUP_ORDER: { kind: SearchHitKind; label: string }[] = [
  { kind: "assignment", label: "Assignments" },
  { kind: "survey", label: "Surveys" },
  { kind: "discussion", label: "Discussion" },
  { kind: "discussion-topic", label: "Discussion topics" },
  { kind: "help-queue", label: "Help queues" },
  { kind: "page", label: "Pages" },
  { kind: "setting", label: "Settings" }
];

export function filterSearchIndex(index: SearchHit[], rawQuery: string): SearchHitGroup[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    // Empty query: surface only pages so the palette is useful as a launcher.
    const pageHits = index.filter((h) => h.kind === "page" || h.kind === "setting").slice(0, TOTAL_CAP);
    return groupHits(pageHits);
  }
  const words = q.split(/\s+/).filter(Boolean);
  const matches: { hit: SearchHit; rank: number }[] = [];
  for (const hit of index) {
    const title = hit.title.toLowerCase();
    const subtitle = (hit.subtitle ?? "").toLowerCase();
    const keywords = (hit.keywords ?? []).map((k) => k.toLowerCase());
    let titleHits = 0;
    let subtitleHits = 0;
    let keywordHits = 0;
    let missing = false;
    for (const w of words) {
      const inTitle = title.includes(w);
      const inSub = subtitle.includes(w);
      const inKw = keywords.some((k) => k.includes(w));
      if (!inTitle && !inSub && !inKw) {
        missing = true;
        break;
      }
      if (inTitle) titleHits++;
      else if (inSub) subtitleHits++;
      else keywordHits++;
    }
    if (missing) continue;
    // Title matches outweigh subtitle, subtitle outweighs keywords.
    const rank = titleHits * 6 + subtitleHits * 2 + keywordHits * 1;
    matches.push({ hit, rank });
  }
  matches.sort((a, b) => b.rank - a.rank || a.hit.title.localeCompare(b.hit.title));
  return groupHits(
    matches.map((m) => m.hit),
    PER_GROUP_CAP,
    TOTAL_CAP
  );
}

function groupHits(hits: SearchHit[], perGroup: number = PER_GROUP_CAP, total: number = TOTAL_CAP): SearchHitGroup[] {
  const groups: SearchHitGroup[] = GROUP_ORDER.map((g) => ({ ...g, hits: [] }));
  let used = 0;
  for (const hit of hits) {
    if (used >= total) break;
    const group = groups.find((g) => g.kind === hit.kind);
    if (!group) continue;
    if (group.hits.length >= perGroup) continue;
    group.hits.push(hit);
    used++;
  }
  return groups.filter((g) => g.hits.length > 0);
}

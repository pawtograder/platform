/**
 * Display layout for gradebook column groups, shared by the instructor table and the student
 * What-If view.
 *
 * Two sources produce the same shape:
 *   - `databaseLayout` reads `gradebook_columns.group_id` and `gradebook_column_groups`, for
 *     courses with the `gradebook-column-groups` feature enabled.
 *   - `legacySlugLayout` is the browser heuristic the gradebook used before groups were stored
 *     (slug prefix plus a sort_order contiguity check), kept for courses still on it.
 *
 * The result is an insertion-ordered record of display units. Every key is a non-integer string,
 * so `Object.entries` preserves display order. A unit is a header group when `isHeaderGroup`
 * says so; otherwise it is one plain column.
 */

export type LayoutColumn = {
  id: number;
  slug: string | null;
  sort_order: number | null;
  name: string;
  group_id?: number | null;
  topic_id?: number | null;
  attempt_number?: number | null;
};

export type LayoutGroup = { id: number; name: string };

export type LayoutTopic = {
  id: number;
  name: string;
  standing_column_id: number | null;
  standing_rule: string | null;
};

export type GroupedColumnsEntry<C> = {
  /** Header text. Legacy names are singular and pluralized at render time; stored names render verbatim. */
  groupName: string;
  /** Stored group id, or null for a legacy run / a plain column / a topic. */
  groupId: number | null;
  /** Set for a topic unit: its columns are the standing (if any) followed by the attempts in order. */
  topicId?: number;
  /** The topic's standing column, shown when the unit is collapsed. */
  standingColumnId?: number | null;
  standingRule?: string | null;
  columns: C[];
};

export type GroupedColumns<C> = Record<string, GroupedColumnsEntry<C>>;

/** Display order: sort_order with NULLs last, then id. */
export function compareColumnOrder(a: LayoutColumn, b: LayoutColumn): number {
  if (a.sort_order == null && b.sort_order != null) return 1;
  if (a.sort_order != null && b.sort_order == null) return -1;
  if (a.sort_order != null && b.sort_order != null && a.sort_order !== b.sort_order) {
    return a.sort_order - b.sort_order;
  }
  return a.id - b.id;
}

/** True when the unit renders a group header: any stored group or topic (even of one), or a legacy run of two or more. */
export function isHeaderGroup<C>(entry: GroupedColumnsEntry<C>): boolean {
  return entry.groupId != null || entry.topicId != null || entry.columns.length > 1;
}

/**
 * Topic view: each topic becomes one unit, placed where its standing column sits (or its first
 * attempt, without a standing), holding the standing and then the attempts in attempt order.
 * Every other column keeps the unit it has in `base` (the group layout), minus the columns the
 * topics took. Topics the caller can't see, or with no visible column, are left out.
 */
export function topicLayout<C extends LayoutColumn>(
  base: GroupedColumns<C>,
  topics: readonly LayoutTopic[]
): GroupedColumns<C> {
  const columns = Object.values(base).flatMap((e) => e.columns);
  const byId = new Map(columns.map((c) => [c.id, c]));
  const topicUnits = new Map<number, GroupedColumnsEntry<C>>();
  const anchorOf = new Map<number, number>(); // column id that marks where the topic is drawn
  for (const topic of topics) {
    const attempts = columns
      .filter((c) => c.topic_id === topic.id)
      .sort((a, b) => (a.attempt_number ?? 0) - (b.attempt_number ?? 0) || a.id - b.id);
    const standing = topic.standing_column_id != null ? byId.get(topic.standing_column_id) : undefined;
    const members = standing ? [standing, ...attempts.filter((a) => a.id !== standing.id)] : attempts;
    if (members.length === 0) continue;
    topicUnits.set(topic.id, {
      groupName: topic.name,
      groupId: null,
      topicId: topic.id,
      standingColumnId: standing?.id ?? null,
      standingRule: topic.standing_rule,
      columns: members
    });
    anchorOf.set(topic.id, (standing ?? attempts[0]).id);
  }
  const taken = new Set([...topicUnits.values()].flatMap((u) => u.columns.map((c) => c.id)));
  const anchorTopic = new Map([...anchorOf].map(([topicId, colId]) => [colId, topicId]));

  const result: GroupedColumns<C> = {};
  for (const [key, entry] of Object.entries(base)) {
    for (const col of entry.columns) {
      const topicId = anchorTopic.get(col.id);
      if (topicId != null) result[`topic:${topicId}`] = topicUnits.get(topicId)!;
    }
    const rest = entry.columns.filter((c) => !taken.has(c.id));
    if (rest.length === 0) continue;
    result[key] = rest.length === entry.columns.length ? entry : { ...entry, columns: rest };
  }
  return result;
}

/** The column a collapsed unit shows: a topic's standing when it has one, else `fallback`. */
export function collapsedColumnFor<C extends LayoutColumn>(
  entry: GroupedColumnsEntry<C>,
  fallback: (columns: C[]) => C
): C {
  if (entry.standingColumnId != null) {
    const standing = entry.columns.find((c) => c.id === entry.standingColumnId);
    if (standing) return standing;
  }
  return fallback(entry.columns);
}

/**
 * Units from stored groups. A group is drawn at the position of its first member, with all its
 * members following in their own order, so a group whose members are not contiguous in
 * sort_order still renders as one group. A column naming a group the caller doesn't have (a
 * student who has not yet received the group row) renders ungrouped.
 */
export function databaseLayout<C extends LayoutColumn>(
  columns: readonly C[],
  groups: readonly LayoutGroup[]
): GroupedColumns<C> {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const ordered = [...columns].sort(compareColumnOrder);
  const result: GroupedColumns<C> = {};
  for (const col of ordered) {
    const group = col.group_id != null ? groupsById.get(col.group_id) : undefined;
    if (group) {
      const key = `group:${group.id}`;
      if (!result[key]) {
        result[key] = { groupName: group.name, groupId: group.id, columns: [] };
      }
      result[key].columns.push(col);
    } else {
      result[`col:${col.id}`] = { groupName: col.name, groupId: null, columns: [col] };
    }
  }
  return result;
}

/** Legacy family of a slug: `assignment-<type>` for three-or-more-part assignment slugs, else the first part, else "other". */
export function legacySlugFamily(slug: string | null): string {
  const parts = (slug ?? "").split("-");
  if (parts[0] === "assignment" && parts.length >= 3) {
    return `${parts[0]}-${parts[1]}`;
  }
  return parts[0] || "other";
}

/**
 * The pre-groups browser heuristic, unchanged in behaviour: order by `sort_order ?? 0`, start a
 * new run when the family changes or sort_order is not exactly the previous + 1.
 */
export function legacySlugLayout<C extends LayoutColumn>(columns: readonly C[]): GroupedColumns<C> {
  const groups: GroupedColumns<C> = {};
  const ordered = [...columns].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  let currentFamily = "";
  let index = 0;
  let lastSortOrder = -1;
  for (const col of ordered) {
    const family = legacySlugFamily(col.slug);
    const sortOrder = col.sort_order ?? 0;
    const isContiguous = lastSortOrder === -1 || sortOrder === lastSortOrder + 1;
    if (!isContiguous || family !== currentFamily) {
      currentFamily = family;
      index++;
    }
    const key = `${family}-${index}`;
    if (!groups[key]) {
      let displayName: string;
      if (family === "other") {
        displayName = "Other";
      } else if (family.startsWith("assignment-")) {
        const subType = family.split("-")[1];
        displayName = subType.charAt(0).toUpperCase() + subType.slice(1);
      } else {
        displayName = family.charAt(0).toUpperCase() + family.slice(1);
      }
      groups[key] = { groupName: displayName, groupId: null, columns: [] };
    }
    groups[key].columns.push(col);
    lastSortOrder = sortOrder;
  }
  return groups;
}

/** Column id -> key of the unit that holds it. */
export function columnUnitKeys<C extends LayoutColumn>(grouped: GroupedColumns<C>): Map<number, string> {
  const map = new Map<number, string>();
  for (const [key, entry] of Object.entries(grouped)) {
    for (const col of entry.columns) map.set(col.id, key);
  }
  return map;
}

/** Every column id, in display order. */
export function displayOrder<C extends LayoutColumn>(grouped: GroupedColumns<C>): number[] {
  return Object.values(grouped).flatMap((entry) => entry.columns.map((c) => c.id));
}

/**
 * New full column order after moving one column a step left (-1) or right (+1), or null when it
 * can't move. A column in a stored group moves only within that group. An ungrouped column steps
 * over a whole neighbouring unit, so it never lands inside a group.
 */
export function moveColumnInLayout<C extends LayoutColumn>(
  grouped: GroupedColumns<C>,
  columnId: number,
  direction: -1 | 1
): number[] | null {
  const units = Object.entries(grouped);
  const unitIdx = units.findIndex(([, entry]) => entry.columns.some((c) => c.id === columnId));
  if (unitIdx === -1) return null;
  const [, entry] = units[unitIdx];

  if (entry.groupId != null) {
    const ids = entry.columns.map((c) => c.id);
    const i = ids.indexOf(columnId);
    const j = i + direction;
    if (j < 0 || j >= ids.length) return null;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const blocks = units.map(([, e], k) => (k === unitIdx ? ids : e.columns.map((c) => c.id)));
    return blocks.flat();
  }
  return moveUnit(units, unitIdx, direction);
}

/** New full column order after moving a whole unit (a group, or a plain column) one unit left or right. */
export function moveGroupInLayout<C extends LayoutColumn>(
  grouped: GroupedColumns<C>,
  unitKey: string,
  direction: -1 | 1
): number[] | null {
  const units = Object.entries(grouped);
  const unitIdx = units.findIndex(([key]) => key === unitKey);
  if (unitIdx === -1) return null;
  return moveUnit(units, unitIdx, direction);
}

function moveUnit<C extends LayoutColumn>(
  units: [string, GroupedColumnsEntry<C>][],
  unitIdx: number,
  direction: -1 | 1
): number[] | null {
  const target = unitIdx + direction;
  if (target < 0 || target >= units.length) return null;
  const blocks = units.map(([, e]) => e.columns.map((c) => c.id));
  [blocks[unitIdx], blocks[target]] = [blocks[target], blocks[unitIdx]];
  return blocks.flat();
}

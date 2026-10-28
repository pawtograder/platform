"use client";

import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { useGradebookController } from "@/hooks/useGradebook";
import {
  moveColumnInLayout,
  moveGroupInLayout,
  type GroupedColumns,
  type LayoutColumn
} from "@/lib/gradebookColumnGroups";
import { createClient } from "@/utils/supabase/client";
import type { GradebookColumnGroup } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Dialog, IconButton, Input, NativeSelect, Portal, Text, VStack } from "@chakra-ui/react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { LuArrowLeft, LuArrowRight, LuEllipsisVertical, LuPencil, LuTrash } from "react-icons/lu";

/** What the column header and dialogs need from the table about groups. */
export type ColumnGroupsContextValue = {
  /** The course stores its own groups (gradebook-column-groups feature). */
  enabled: boolean;
  groups: GradebookColumnGroup[];
  groupedColumns: GroupedColumns<LayoutColumn>;
};

export const ColumnGroupsContext = createContext<ColumnGroupsContextValue>({
  enabled: false,
  groups: [],
  groupedColumns: {}
});

export function useColumnGroupsContext() {
  return useContext(ColumnGroupsContext);
}

/** RPC wrappers for group writes. Each refetches columns and groups so the table updates without waiting for realtime. */
export function useColumnGroupActions() {
  const gradebookController = useGradebookController();
  const supabase = useMemo(() => createClient(), []);

  const refresh = useCallback(async () => {
    await Promise.all([
      gradebookController.gradebook_columns.refetchAll(),
      gradebookController.gradebook_column_groups.refetchAll()
    ]);
  }, [gradebookController]);

  const run = useCallback(
    async (label: string, op: () => PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await op();
      if (error) {
        toaster.error({ title: label, description: error.message });
        throw new Error(error.message);
      }
      // Realtime already delivers the change; this refetch only closes the gap if a broadcast is
      // missed, so callers (dialogs) don't wait on it.
      void refresh().catch(() => {});
    },
    [refresh]
  );

  return useMemo(
    () => ({
      reorder: (order: number[]) =>
        run("Failed to reorder columns", () =>
          supabase.rpc("gradebook_columns_reorder", { p_ordered_column_ids: order })
        ),
      setGroup: (columnIds: number[], groupId: number | null) =>
        run("Failed to change the column's group", () =>
          // A NULL group ungroups; the generated type has no `| null` for an RPC argument.
          supabase.rpc("gradebook_columns_set_group", {
            p_column_ids: columnIds,
            p_group_id: groupId as number
          })
        ),
      createGroup: (name: string, columnIds: number[]) =>
        run("Failed to create the group", () =>
          supabase.rpc("gradebook_column_group_create", {
            p_gradebook_id: gradebookController.gradebook_id,
            p_name: name,
            p_column_ids: columnIds
          })
        ),
      renameGroup: (groupId: number, name: string) =>
        run("Failed to rename the group", () =>
          supabase.from("gradebook_column_groups").update({ name }).eq("id", groupId)
        ),
      deleteGroup: (groupId: number) =>
        run("Failed to delete the group", () => supabase.from("gradebook_column_groups").delete().eq("id", groupId)),
      autoGroup: () =>
        run("Failed to auto-group columns", () =>
          supabase.rpc("gradebook_columns_auto_group", { p_gradebook_id: gradebookController.gradebook_id })
        )
    }),
    [run, supabase, gradebookController]
  );
}

/** A column's group in a form: none, an existing group, or a new one by name. */
export type GroupChoice = { kind: "none" } | { kind: "existing"; id: number } | { kind: "new"; name: string };

export function groupChoiceFor(groupId: number | null | undefined): GroupChoice {
  return groupId == null ? { kind: "none" } : { kind: "existing", id: groupId };
}

/** Apply a GroupChoice to one column, doing nothing when it is unchanged. */
export async function applyGroupChoice(
  actions: ReturnType<typeof useColumnGroupActions>,
  columnId: number,
  currentGroupId: number | null | undefined,
  choice: GroupChoice
) {
  if (choice.kind === "none") {
    if (currentGroupId != null) await actions.setGroup([columnId], null);
  } else if (choice.kind === "existing") {
    if (choice.id !== currentGroupId) await actions.setGroup([columnId], choice.id);
  } else if (choice.name.trim() !== "") {
    await actions.createGroup(choice.name.trim(), [columnId]);
  }
}

/** Group picker for the Add/Edit Column dialogs and the Move to group dialog. */
export function ColumnGroupSelect({
  value,
  onChange
}: {
  value: GroupChoice;
  onChange: (choice: GroupChoice) => void;
}) {
  const { groups } = useColumnGroupsContext();
  const sorted = useMemo(() => [...groups].sort((a, b) => a.name.localeCompare(b.name)), [groups]);
  const selectValue = value.kind === "existing" ? String(value.id) : value.kind;
  return (
    <VStack align="stretch" gap={2}>
      <NativeSelect.Root>
        <NativeSelect.Field
          id="columnGroup"
          aria-label="Group"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "none") onChange({ kind: "none" });
            else if (v === "new") onChange({ kind: "new", name: "" });
            else onChange({ kind: "existing", id: Number(v) });
          }}
        >
          <option value="none">No group</option>
          {sorted.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value="new">New group…</option>
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
      {value.kind === "new" && (
        <Input
          aria-label="New group name"
          placeholder="Group name"
          value={value.name}
          onChange={(e) => onChange({ kind: "new", name: e.target.value })}
        />
      )}
    </VStack>
  );
}

export function MoveToGroupDialog({
  columnId,
  columnName,
  currentGroupId,
  onClose
}: {
  columnId: number;
  columnName: string;
  currentGroupId: number | null;
  onClose: () => void;
}) {
  const actions = useColumnGroupActions();
  const [choice, setChoice] = useState<GroupChoice>(groupChoiceFor(currentGroupId));
  const [isSaving, setIsSaving] = useState(false);
  const save = async () => {
    setIsSaving(true);
    try {
      await applyGroupChoice(actions, columnId, currentGroupId, choice);
      onClose();
    } catch {
      // toasted by the action
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(d) => !d.open && onClose()} size="sm" placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Group for &ldquo;{columnName}&rdquo;</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <ColumnGroupSelect value={choice} onChange={setChoice} />
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                colorPalette="green"
                onClick={save}
                loading={isSaving}
                disabled={choice.kind === "new" && choice.name.trim() === ""}
              >
                Save
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** New full order after a header-menu Move Left/Right, or null when the column can't move that way. */
export function useGroupAwareColumnMove(columnId: number) {
  const { enabled, groupedColumns } = useColumnGroupsContext();
  return useMemo(
    () => ({
      enabled,
      left: enabled ? moveColumnInLayout(groupedColumns, columnId, -1) : null,
      right: enabled ? moveColumnInLayout(groupedColumns, columnId, 1) : null
    }),
    [enabled, groupedColumns, columnId]
  );
}

/** Menu on a stored group's header: rename, move, delete. */
export function GroupHeaderMenu({ groupKey, groupId, name }: { groupKey: string; groupId: number; name: string }) {
  const { groupedColumns } = useColumnGroupsContext();
  const actions = useColumnGroupActions();
  const [isRenaming, setIsRenaming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const left = moveGroupInLayout(groupedColumns, groupKey, -1);
  const right = moveGroupInLayout(groupedColumns, groupKey, 1);

  return (
    <Box onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} flexShrink={0}>
      <MenuRoot>
        <MenuTrigger asChild>
          <IconButton variant="ghost" size="2xs" aria-label={`Group options for ${name}`}>
            <LuEllipsisVertical />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem value="rename" onClick={() => setIsRenaming(true)}>
            <LuPencil /> Rename group
          </MenuItem>
          <MenuItem value="left" disabled={!left} onClick={() => left && actions.reorder(left).catch(() => {})}>
            <LuArrowLeft /> Move group left
          </MenuItem>
          <MenuItem value="right" disabled={!right} onClick={() => right && actions.reorder(right).catch(() => {})}>
            <LuArrowRight /> Move group right
          </MenuItem>
          <MenuSeparator />
          <MenuItem value="delete" color="fg.error" onClick={() => setIsDeleting(true)}>
            <LuTrash /> Delete group
          </MenuItem>
        </MenuContent>
      </MenuRoot>
      {isRenaming && (
        <RenameGroupDialog
          name={name}
          onSave={(newName) => actions.renameGroup(groupId, newName)}
          onClose={() => setIsRenaming(false)}
        />
      )}
      {isDeleting && (
        <Dialog.Root open onOpenChange={(d) => !d.open && setIsDeleting(false)} size="sm" placement="center">
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Delete group &ldquo;{name}&rdquo;?</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                  <Text>Its columns stay where they are, ungrouped. No grades change.</Text>
                </Dialog.Body>
                <Dialog.Footer>
                  <Button variant="outline" onClick={() => setIsDeleting(false)}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette="red"
                    onClick={() =>
                      actions
                        .deleteGroup(groupId)
                        .then(() => setIsDeleting(false))
                        .catch(() => {})
                    }
                  >
                    Delete group
                  </Button>
                </Dialog.Footer>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
    </Box>
  );
}

function RenameGroupDialog({
  name,
  onSave,
  onClose
}: {
  name: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(name);
  const [isSaving, setIsSaving] = useState(false);
  const save = async () => {
    setIsSaving(true);
    try {
      await onSave(value.trim());
      onClose();
    } catch {
      // toasted by the action (a duplicate name is the usual cause)
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(d) => !d.open && onClose()} size="sm" placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Rename group</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Input aria-label="Group name" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                colorPalette="green"
                onClick={save}
                loading={isSaving}
                disabled={value.trim() === "" || value.trim() === name}
              >
                Rename
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

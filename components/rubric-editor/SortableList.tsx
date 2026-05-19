"use client";

import { Box, HStack, IconButton } from "@chakra-ui/react";
import {
  closestCenter,
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ReactNode } from "react";
import { LuGripVertical } from "react-icons/lu";

export type SortableItem = {
  id: string | number;
};

type SortableRowProps = {
  id: string | number;
  children: ReactNode;
  handleAriaLabel?: string;
};

function SortableRow({ id, children, handleAriaLabel = "Drag to reorder" }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  };

  return (
    <Box ref={setNodeRef} style={style} w="100%">
      <HStack align="stretch" gap={1} w="100%">
        <IconButton aria-label={handleAriaLabel} variant="ghost" size="xs" cursor="grab" {...attributes} {...listeners}>
          <LuGripVertical />
        </IconButton>
        <Box flex="1" minW="0">
          {children}
        </Box>
      </HStack>
    </Box>
  );
}

type SortableListProps<T extends SortableItem> = {
  items: T[];
  onReorder: (next: T[]) => void;
  renderItem: (item: T, index: number) => ReactNode;
  getItemId: (item: T, index: number) => string | number;
  handleAriaLabel?: (item: T, index: number) => string;
};

export function SortableList<T extends SortableItem>({
  items,
  onReorder,
  renderItem,
  getItemId,
  handleAriaLabel
}: SortableListProps<T>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const ids = items.map((item, index) => getItemId(item, index));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = ids.indexOf(active.id as string | number);
    const newIndex = ids.indexOf(over.id as string | number);
    if (oldIndex === -1 || newIndex === -1) return;

    const next = items.slice();
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    // Eagerly re-number ordinal so the GUI matches what the YAML round-trip will
    // produce on save (parse.ts assigns ordinal = array index).
    const renumbered = next.map((item, index) => ({ ...item, ordinal: index }));
    onReorder(renumbered);
  };

  return (
    // restrictToParentElement keeps the grip from yanking a card outside its
    // parent (parts inside parts list, criteria inside their part, etc).
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToParentElement, restrictToVerticalAxis]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {items.map((item, index) => (
          <SortableRow
            key={ids[index]}
            id={ids[index]}
            handleAriaLabel={handleAriaLabel ? handleAriaLabel(item, index) : undefined}
          >
            {renderItem(item, index)}
          </SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}

export function findChanges<T extends { id: number | undefined | null }>(
  newItems: T[],
  existingItems: T[]
): {
  toCreate: T[];
  toUpdate: T[];
  toDelete: number[];
  numItemsWithBadIDs: number;
} {
  const existingItemMap = new Map(existingItems.map((item) => [item.id, item]));

  const toCreate: T[] = [];
  const toUpdate: T[] = [];

  let numItemsWithBadIDs = 0;
  for (const newItem of newItems) {
    if (newItem.id === undefined || newItem.id === null || newItem.id <= 0) {
      toCreate.push(newItem);
    } else {
      const existingItem = existingItemMap.get(newItem.id);
      if (existingItem) {
        if (JSON.stringify(newItem) !== JSON.stringify(existingItem)) {
          toUpdate.push(newItem);
        }
        existingItemMap.delete(newItem.id);
      } else {
        numItemsWithBadIDs++;
        toCreate.push(newItem);
      }
    }
  }

  const toDelete: number[] = Array.from(existingItemMap.keys()).filter(
    (id): id is number => id !== undefined && id !== null && id > 0
  );

  return { toCreate, toUpdate, toDelete, numItemsWithBadIDs };
}

/**
 * Returns the property names of an object that have changed compared to another object, excluding arrays and certain metadata fields.
 *
 * Compares two objects of the same type and identifies which non-array, non-metadata properties have different values. For the `data` property, a deep comparison is performed using JSON stringification.
 */
export function findUpdatedPropertyNames<T extends object>(newItem: T, existingItem: T): (keyof T)[] {
  return Object.keys(newItem)
    .filter(
      (key) =>
        !Array.isArray(newItem[key as keyof T]) &&
        key !== "rubric_id" &&
        key !== "class_id" &&
        key !== "created_at" &&
        key !== "assignment_id"
    )
    .filter(
      (key) =>
        (key === "data" &&
          newItem[key as keyof T] != existingItem[key as keyof T] &&
          JSON.stringify(newItem[key as keyof T]) != JSON.stringify(existingItem[key as keyof T])) ||
        newItem[key as keyof T] != existingItem[key as keyof T]
    ) as (keyof T)[];
}

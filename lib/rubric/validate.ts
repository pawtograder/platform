import { RubricChecksDataType, YmlRubricChecksType } from "@/utils/supabase/DatabaseTypes";

export function rubricCheckDataOrThrow(check: YmlRubricChecksType): RubricChecksDataType | undefined {
  if (!check.data) {
    return undefined;
  }

  if (
    typeof check.data === "object" &&
    check.data !== null &&
    "options" in check.data &&
    Array.isArray((check.data as { options?: unknown }).options)
  ) {
    const specificData = check.data as RubricChecksDataType;

    if (specificData.options?.length === 1) {
      throw new Error("Checks may not have only one option - they must have at least two options, or can have none");
    }
    for (const option of specificData.options) {
      if (option.points === undefined || option.points === null) {
        throw new Error("Option points are required");
      }
      if (!option.label) {
        throw new Error("Option label is required");
      }
    }
    return specificData;
  } else if (typeof check.data === "object" && check.data !== null && !("options" in check.data)) {
    return undefined;
  }

  return undefined;
}

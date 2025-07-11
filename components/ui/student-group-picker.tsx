import { useMemo } from "react";
import { Select } from "chakra-react-select";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Field } from "@/components/ui/field";
import type { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { toaster } from "./toaster";

type StudentOption = {
  label: string;
  value: string;
};

type StudentGroupPickerProps = {
  selectedStudents: string[];
  /**
   * Callback when student selection changes
   * @param students - Array of selected student profile IDs
   */
  onSelectionChange: (students: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
  helperText?: string;
  required?: boolean;
  errorMessage?: string;
  invalid?: boolean;
  isClearable?: boolean;
  maxSelections?: number;
  minSelections?: number;
  /**
   * Array of student IDs that cannot be removed (e.g., current user)
   */
  requiredStudents?: string[];
};

/**
 * A reusable component for selecting multiple class members from the class roster.
 * Provides a searchable dropdown interface with support for multi-selection.
 * Note: Due to RLS policies, this shows all visible class members rather than just students.
 *
 * @param props - The component props
 * @returns JSX element for class member selection
 */
export default function StudentGroupPicker({
  selectedStudents,
  onSelectionChange,
  disabled = false,
  placeholder = "Search and select class members...",
  label,
  helperText,
  required = false,
  errorMessage,
  invalid = false,
  isClearable = true,
  maxSelections,
  minSelections = 0,
  requiredStudents = []
}: StudentGroupPickerProps) {
  const classProfiles = useClassProfiles();

  // Convert available profiles to options for the select component
  const studentOptions: StudentOption[] = useMemo(() => {
    return classProfiles.profiles
      .map((profile: UserProfile) => ({
        label: profile.name || `User ${profile.id}`,
        value: profile.id
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [classProfiles.profiles]);

  // Convert selected student IDs to option objects
  const selectedOptions = useMemo(() => {
    return selectedStudents
      .map((studentId) => studentOptions.find((option) => option.value === studentId))
      .filter(Boolean) as StudentOption[];
  }, [selectedStudents, studentOptions]);

  const handleSelectionChange = (newOptions: StudentOption[]) => {
    const newStudentIds = newOptions.map((option) => option.value);

    // Check if required students were attempted to be removed
    const removedRequiredStudents = requiredStudents.filter((id) => !newStudentIds.includes(id));
    if (removedRequiredStudents.length > 0) {
      const requiredNames = removedRequiredStudents
        .map((id) => studentOptions.find((opt) => opt.value === id)?.label)
        .filter(Boolean)
        .join(", ");

      toaster.error({
        title: "Cannot remove required students",
        description: `${requiredNames} cannot be removed from this help request.`
      });
      return;
    }

    // Check if the new selection would violate minimum requirements
    if (newStudentIds.length < minSelections) {
      toaster.error({
        title: "Minimum selection required",
        description: `At least ${minSelections} student${minSelections === 1 ? "" : "s"} must be selected.`
      });
      return;
    }

    onSelectionChange(newStudentIds);
  };

  const isMaxReached = maxSelections ? selectedStudents.length >= maxSelections : false;
  const isAtMinimum = selectedStudents.length <= minSelections;

  const fieldContent = (
    <Select<StudentOption, true>
      isMulti={true}
      isClearable={isClearable && !isAtMinimum}
      isDisabled={disabled}
      placeholder={isMaxReached ? `Maximum ${maxSelections} members selected` : placeholder}
      options={studentOptions}
      value={selectedOptions}
      onChange={(options) => handleSelectionChange(Array.from(options || []))}
      noOptionsMessage={({ inputValue }) =>
        inputValue ? `No users found matching "${inputValue}"` : "No users available"
      }
      // Disable adding more options if max is reached
      isOptionDisabled={() => isMaxReached}
      closeMenuOnSelect={false}
      hideSelectedOptions={false}
      controlShouldRenderValue={true}
      menuPlacement="auto"
      maxMenuHeight={200}
    />
  );

  if (!label) {
    return fieldContent;
  }

  return (
    <Field label={label} required={required} helperText={helperText} errorText={errorMessage} invalid={invalid}>
      {fieldContent}
    </Field>
  );
}

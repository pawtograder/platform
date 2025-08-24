"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Select } from "chakra-react-select";

interface TermSelectorProps {
  value: number;
  onChange: (value: number) => void;
  label?: string;
  required?: boolean;
  className?: string;
}

type TermOption = {
  value: number;
  label: string;
};

export function TermSelector({ value, onChange, label = "Term", required = false, className = "" }: TermSelectorProps) {
  const [selectedTerm, setSelectedTerm] = useState<TermOption | null>(null);

  // Generate all term options (past 5 years + current year + next year, with all semesters)
  const termOptions: TermOption[] = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const options: TermOption[] = [];

    // Past 5 years + current year + next year
    for (let year = currentYear - 5; year <= currentYear + 1; year++) {
      // Spring (30), Summer (20), Fall (10)
      options.push(
        { value: parseInt(`${year}10`), label: `Fall ${year - 1}` },
        { value: parseInt(`${year}30`), label: `Spring ${year}` },
        { value: parseInt(`${year}20`), label: `Summer ${year}` }
      );
    }

    return options;
  }, []);

  // Set the selected term when value changes
  useEffect(() => {
    if (value) {
      const option = termOptions.find((opt) => opt.value === value);
      setSelectedTerm(option || null);
    } else {
      // Default to current year fall
      const currentYear = new Date().getFullYear();
      const defaultOption = termOptions.find((opt) => opt.value === parseInt(`${currentYear}10`));
      setSelectedTerm(defaultOption || null);
    }
  }, [value, termOptions]);

  const handleTermChange = useCallback(
    (option: TermOption | null) => {
      setSelectedTerm(option);
      if (option) {
        onChange(option.value);
      }
    },
    [onChange]
  );

  return (
    <div className={className}>
      <Label htmlFor="term-selector">
        {label}
        {required && " *"}
      </Label>
      <Select<TermOption>
        value={selectedTerm}
        onChange={handleTermChange}
        options={termOptions}
        placeholder="Select term..."
        isClearable={false}
        className="w-full"
      />

      {value && <div className="text-sm text-muted-foreground mt-1">Banner format: {value}</div>}
    </div>
  );
}

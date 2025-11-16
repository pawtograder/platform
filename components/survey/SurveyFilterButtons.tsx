import { HStack, Button } from "@chakra-ui/react";

export type FilterOption<T extends string> = {
  value: T;
  label: string;
};

type SurveyFilterButtonsProps<T extends string> = {
  activeFilter: T;
  setActiveFilter: (filter: T) => void;
  filterOptions: FilterOption<T>[];
  filterButtonActiveBg: string;
  filterButtonActiveColor: string;
  filterButtonInactiveBg: string;
  filterButtonInactiveColor: string;
  filterButtonHoverBg: string;
  tableBorderColor: string;
};

export default function SurveyFilterButtons<T extends string>({
  activeFilter,
  setActiveFilter,
  filterOptions,
  filterButtonActiveBg,
  filterButtonActiveColor,
  filterButtonInactiveBg,
  filterButtonInactiveColor,
  filterButtonHoverBg,
  tableBorderColor
}: SurveyFilterButtonsProps<T>) {
  return (
    <HStack gap={2} mb={4} wrap="wrap">
      {filterOptions.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant="outline"
          bg={activeFilter === option.value ? filterButtonActiveBg : filterButtonInactiveBg}
          color={activeFilter === option.value ? filterButtonActiveColor : filterButtonInactiveColor}
          borderColor={activeFilter === option.value ? filterButtonActiveBg : tableBorderColor}
          _hover={{
            bg: activeFilter === option.value ? filterButtonActiveBg : filterButtonHoverBg
          }}
          onClick={() => setActiveFilter(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </HStack>
  );
}


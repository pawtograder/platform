import { useState } from "react";
import { SurveyFilterButtons } from "@pawtograder/webapp";

const filterOptions = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Drafts" },
  { value: "closed", label: "Closed" }
];

export const Default = () => {
  const [activeFilter, setActiveFilter] = useState("active");
  return (
    <SurveyFilterButtons
      activeFilter={activeFilter}
      setActiveFilter={setActiveFilter}
      filterOptions={filterOptions}
      filterButtonActiveBg="blue.solid"
      filterButtonActiveColor="white"
      filterButtonInactiveBg="bg.subtle"
      filterButtonInactiveColor="fg.muted"
      filterButtonHoverBg="gray.subtle"
      tableBorderColor="border"
    />
  );
};

export const GreenPalette = () => {
  const [activeFilter, setActiveFilter] = useState("closed");
  return (
    <SurveyFilterButtons
      activeFilter={activeFilter}
      setActiveFilter={setActiveFilter}
      filterOptions={filterOptions}
      filterButtonActiveBg="green.solid"
      filterButtonActiveColor="white"
      filterButtonInactiveBg="bg.subtle"
      filterButtonInactiveColor="fg.muted"
      filterButtonHoverBg="gray.subtle"
      tableBorderColor="border"
    />
  );
};

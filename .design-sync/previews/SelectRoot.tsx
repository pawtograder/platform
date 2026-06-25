import {
  SelectRoot,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValueText,
  SelectLabel,
  SelectItemText,
  createListCollection,
  Box
} from "@pawtograder/webapp";

const assignments = createListCollection({
  items: [
    { label: "Problem Set 3: Binary Trees", value: "ps3" },
    { label: "Problem Set 4: Hash Maps", value: "ps4" },
    { label: "Lab 7: Recursion", value: "lab7" },
    { label: "Final Project Milestone 1", value: "fp1" }
  ]
});

export const OpenDropdown = () => (
  <Box minH="320px">
    <SelectRoot collection={assignments} defaultValue={["ps4"]} open width="320px">
      <SelectLabel>Assignment</SelectLabel>
      <SelectTrigger>
        <SelectValueText placeholder="Select an assignment" />
      </SelectTrigger>
      <SelectContent portalled={false}>
        {assignments.items.map((item) => (
          <SelectItem item={item} key={item.value}>
            <SelectItemText>{item.label}</SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  </Box>
);

export const ClosedWithValue = () => (
  <SelectRoot collection={assignments} defaultValue={["lab7"]} width="320px">
    <SelectLabel>Assignment</SelectLabel>
    <SelectTrigger>
      <SelectValueText placeholder="Select an assignment" />
    </SelectTrigger>
    <SelectContent portalled={false}>
      {assignments.items.map((item) => (
        <SelectItem item={item} key={item.value}>
          <SelectItemText>{item.label}</SelectItemText>
        </SelectItem>
      ))}
    </SelectContent>
  </SelectRoot>
);

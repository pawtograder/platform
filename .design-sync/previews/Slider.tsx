import { Slider, Stack, Box } from "@pawtograder/webapp";

export const Default = () => (
  <Box maxW="360px">
    <Slider defaultValue={[80]} label="Passing threshold" />
  </Box>
);

export const WithValue = () => (
  <Box maxW="360px">
    <Slider defaultValue={[65]} label="Late penalty (%)" showValue />
  </Box>
);

export const WithMarks = () => (
  <Box maxW="360px">
    <Slider
      defaultValue={[70]}
      label="Grade cutoff"
      marks={[
        { value: 0, label: "F" },
        { value: 60, label: "D" },
        { value: 70, label: "C" },
        { value: 80, label: "B" },
        { value: 90, label: "A" }
      ]}
    />
  </Box>
);

export const Range = () => (
  <Box maxW="360px">
    <Slider
      defaultValue={[40, 75]}
      label="Curve range"
      showValue
      colorPalette="green"
    />
  </Box>
);

export const Sizes = () => (
  <Stack gap={6} maxW="360px">
    <Slider size="sm" defaultValue={[50]} label="Small" />
    <Slider size="md" defaultValue={[60]} label="Medium" />
    <Slider size="lg" defaultValue={[70]} label="Large" />
  </Stack>
);

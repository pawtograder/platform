import { Button } from "@chakra-ui/react";

export default function TagDisplay({ name, color }: { name: string; color: string }) {
  return (
    <Button _hover={{}} height="fit-content" padding="3px" colorPalette={color} justifyContent={"center"}>
      {name}
    </Button>
  );
}

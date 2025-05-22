import { Flex } from "@chakra-ui/react";
import { Key } from "react";

export default function TagDisplay({ name, color, key }: { name: string; color: string; key?: Key }) {
  return key != undefined ? (
    <Flex key={key} padding="2px" backgroundColor={color} borderRadius={"25px"} minWidth="20" justifyContent={"center"}>
      {name}
    </Flex>
  ) : (
    <Flex padding="2px" backgroundColor={color} borderRadius={"25px"} minWidth="20" justifyContent={"center"}>
      {name}
    </Flex>
  );
}

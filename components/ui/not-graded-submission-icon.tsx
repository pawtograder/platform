import { FaInfo } from "react-icons/fa";

import { Icon } from "@chakra-ui/react";
import { Tooltip } from "./tooltip";

export function NotGradedSubmissionIcon() {
  return (
    <Tooltip content="This submission was created with #NOT-GRADED in the commit message and cannot ever become active. It will not be graded.">
      <Icon color="fg.warning">
        <FaInfo />
      </Icon>
    </Tooltip>
  );
}

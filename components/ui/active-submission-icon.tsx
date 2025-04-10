import { FaFlagCheckered } from "react-icons/fa";

import { Icon } from "@chakra-ui/react";
import { Tooltip } from "./tooltip";

export function ActiveSubmissionIcon() {
    return <Tooltip content="This refers to an 'active' submission, which is the submission that will be graded.">
        <Icon><FaFlagCheckered /></Icon>
    </Tooltip>
}
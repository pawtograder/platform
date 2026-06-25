import { Tooltip, Button, IconButton, HStack, Icon } from "@pawtograder/webapp";
import { LuInfo, LuClock } from "react-icons/lu";

export const LatePenaltyTooltip = () => (
  <Tooltip open showArrow portalled={false} content="Submitted 6h late · 10% penalty applied">
    <Button variant="outline" size="sm">
      <Icon as={LuClock} />
      Late
    </Button>
  </Tooltip>
);

export const RubricInfoTooltip = () => (
  <Tooltip
    open
    showArrow
    portalled={false}
    content="Full marks require all edge cases covered, including empty input."
  >
    <IconButton aria-label="Rubric info" variant="ghost" size="sm">
      <LuInfo />
    </IconButton>
  </Tooltip>
);

export const RegradeTooltip = () => (
  <Tooltip open showArrow portalled={false} content="Re-runs the autograder against the latest commit">
    <Button colorPalette="blue" size="sm">
      Re-run autograder
    </Button>
  </Tooltip>
);

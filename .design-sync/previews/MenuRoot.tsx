import {
  MenuRoot,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuItemGroup,
  MenuSeparator,
  Button
} from "@pawtograder/webapp";
import { LuEye, LuRefreshCw, LuDownload, LuUserMinus, LuChevronDown } from "react-icons/lu";

export const SubmissionActionsMenu = () => (
  <MenuRoot open>
    <MenuTrigger asChild>
      <Button variant="outline" size="sm">
        Actions
        <LuChevronDown />
      </Button>
    </MenuTrigger>
    <MenuContent portalled={false}>
      <MenuItem value="view">
        <LuEye />
        View submission
      </MenuItem>
      <MenuItem value="regrade">
        <LuRefreshCw />
        Request regrade
      </MenuItem>
      <MenuItem value="download">
        <LuDownload />
        Download repo
      </MenuItem>
      <MenuSeparator />
      <MenuItem value="remove" color="fg.error">
        <LuUserMinus />
        Remove from group
      </MenuItem>
    </MenuContent>
  </MenuRoot>
);

export const GradebookMenu = () => (
  <MenuRoot open>
    <MenuTrigger asChild>
      <Button variant="outline" size="sm">
        Problem Set 4
        <LuChevronDown />
      </Button>
    </MenuTrigger>
    <MenuContent portalled={false}>
      <MenuItemGroup title="Grading">
        <MenuItem value="open">Open in grader</MenuItem>
        <MenuItem value="rubric">Edit rubric</MenuItem>
        <MenuItem value="release">Release grades</MenuItem>
      </MenuItemGroup>
      <MenuSeparator />
      <MenuItemGroup title="Export">
        <MenuItem value="csv">Export as CSV</MenuItem>
        <MenuItem value="canvas">Sync to Canvas</MenuItem>
      </MenuItemGroup>
    </MenuContent>
  </MenuRoot>
);

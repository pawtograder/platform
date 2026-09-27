import { Box } from "@pawtograder/webapp";
import { SurveyBuilder } from "@pawtograder/webapp";

const surveyJson = JSON.stringify({
  title: "Sprint 3 Team Check-in",
  pages: [
    {
      name: "progress",
      elements: [
        {
          type: "rating",
          name: "velocity",
          title: "How on-track is your team this sprint?"
        },
        {
          type: "radiogroup",
          name: "blockers",
          title: "Do you have any blockers?",
          choices: ["None", "Minor", "Significant"]
        },
        {
          type: "comment",
          name: "notes",
          title: "Anything the staff should know?"
        }
      ]
    },
    {
      name: "feedback",
      elements: [
        {
          type: "boolean",
          name: "would_recommend",
          title: "Would you recommend this assignment to next year's students?",
          labelTrue: "Yes",
          labelFalse: "No"
        }
      ]
    }
  ]
});

export const TeamSurvey = () => (
  <Box height="640px" overflow="hidden" borderWidth="1px" borderRadius="md">
    <SurveyBuilder value={surveyJson} onChange={() => {}} />
  </Box>
);

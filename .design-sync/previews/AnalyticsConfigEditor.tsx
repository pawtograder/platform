import { useState } from "react";
import { Box } from "@pawtograder/webapp";
import { AnalyticsConfigEditor } from "@pawtograder/webapp";

const surveyJson = {
  title: "Sprint 3 Team Check-in",
  pages: [
    {
      name: "progress",
      elements: [
        {
          type: "rating",
          name: "velocity",
          title: "How on-track is your team this sprint?",
          rateMin: 1,
          rateMax: 5
        },
        {
          type: "rating",
          name: "collaboration",
          title: "How well is your team collaborating?",
          rateMin: 1,
          rateMax: 5
        },
        {
          type: "radiogroup",
          name: "blockers",
          title: "Do you have any blockers?",
          choices: ["None", "Minor", "Significant"]
        }
      ]
    }
  ]
};

const initialConfig = {
  questions: {
    velocity: {
      includeInAnalytics: true,
      alertThreshold: 2.5,
      alertDirection: "below" as const,
      alertMessage: "Team reports lower than expected progress"
    },
    collaboration: {
      includeInAnalytics: false
    }
  },
  globalSettings: {
    varianceThreshold: 1.5,
    nonResponseThreshold: 0.8
  }
};

export const ConfiguredAnalytics = () => {
  const [config, setConfig] = useState(initialConfig);
  return (
    <Box maxW="560px" p={4}>
      <AnalyticsConfigEditor
        surveyJson={surveyJson}
        analyticsConfig={config}
        onChange={setConfig}
      />
    </Box>
  );
};

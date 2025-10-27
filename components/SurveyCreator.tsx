// components/SurveyCreator.tsx
"use client";

import { useState, useEffect } from "react";
import { ICreatorOptions } from "survey-creator-core";
import { SurveyCreatorComponent, SurveyCreator } from "survey-creator-react";
import { useColorModeValue } from "@/components/ui/color-mode";
import SurveyCreatorTheme from "survey-creator-core/themes";
import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";

const defaultCreatorOptions: ICreatorOptions = {
  autoSaveEnabled: true
};

const defaultJson = {
  pages: [
    {
      name: "Name",
      elements: [
        {
          name: "FirstName",
          title: "Enter your first name:",
          type: "text"
        },
        {
          name: "LastName",
          title: "Enter your last name:",
          type: "text"
        }
      ]
    }
  ]
};

export default function SurveyCreatorWidget(props: {
  json?: Object;
  options?: ICreatorOptions;
  startFresh?: boolean;
  onCreatorReady?: (creator: SurveyCreator) => void;
}) {
  const [creator, setCreator] = useState<SurveyCreator | null>(null);
  
  // Get color mode to determine theme (same as survey-preview-modal.tsx)
  const isDarkMode = useColorModeValue(false, true);

  // Initialize creator once
  useEffect(() => {
    if (!creator) {
      const newCreator = new SurveyCreator(props.options || defaultCreatorOptions);

      newCreator.saveSurveyFunc = (saveNo: number, callback: (num: number, status: boolean) => void) => {
        window.localStorage.setItem("survey-json", newCreator.text);
        callback(saveNo, true);
      };

      // Apply SurveyJS Creator theme based on color mode (same logic as survey-preview-modal.tsx)
      if (isDarkMode) {
        newCreator.applyCreatorTheme(SurveyCreatorTheme.DefaultDark);
      }
      // Note: Light theme is the default CSS, so no need to apply anything for light mode

      setCreator(newCreator);

      // Notify parent component that creator is ready
      if (props.onCreatorReady) {
        props.onCreatorReady(newCreator);
      }
    }
  }, [props.options, props.onCreatorReady, isDarkMode]);

  // Handle JSON loading when props change
  useEffect(() => {
    if (!creator) return;

    let jsonToLoad;
    if (props.json) {
      // If explicit JSON is provided, use it
      jsonToLoad = JSON.stringify(props.json);
    } else if (props.startFresh) {
      // If starting fresh, use default JSON and clear localStorage
      window.localStorage.removeItem("survey-json");
      jsonToLoad = JSON.stringify(defaultJson);
    } else {
      // Default behavior: try localStorage, fallback to default
      jsonToLoad = window.localStorage.getItem("survey-json") || JSON.stringify(defaultJson);
    }

    // Set the JSON and ensure the creator is properly initialized
    creator.text = jsonToLoad;

    // Force the creator to load the JSON
    try {
      const parsedJson = JSON.parse(jsonToLoad);
      creator.JSON = parsedJson;
    } catch (error) {
      console.warn("Failed to parse JSON for SurveyCreator:", error);
      creator.JSON = defaultJson;
    }
  }, [creator, props.json, props.startFresh]);

  if (!creator) {
    return (
      <div style={{ height: "100vh", width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div>Loading Survey Creator...</div>
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", width: "100%" }}>
      <SurveyCreatorComponent creator={creator} />
    </div>
  );
}

// function saveSurveyJson (url: string, json: object, saveNo: number, callback: (num: number, status: boolean) => void) {
//   fetch(url, {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json;charset=UTF-8'
//     },
//     body: JSON.stringify(json)
//   })
//   .then(response => {
//     if (response.ok) {
//       callback(saveNo, true);
//     } else {
//       callback(saveNo, false);
//     }
//   })
//   .catch(error => {
//     callback(saveNo, false);
//   });
// }

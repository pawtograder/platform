// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React, { useEffect, type ChangeEvent } from "react";
import { Select, FormField } from "amazon-chime-sdk-component-library-react";

import { AVAILABLE_AWS_REGIONS } from "../../constants";
import getFormattedOptionsForSelect from "../../utils/select-options-format";
import { toaster } from "@/components/ui/toaster";

const regionalOptions = [
  { value: "", label: "Select a region" },
  ...getFormattedOptionsForSelect(AVAILABLE_AWS_REGIONS)
];

interface Props {
  setRegion: React.Dispatch<React.SetStateAction<string>>;
  region: string;
}

const RegionSelection: React.FC<Props> = ({ setRegion, region }) => {
  useEffect(() => {
    let mounted = true;

    async function getNearestRegion() {
      if (region) {
        return;
      }

      try {
        const res = await fetch("https://nearest-media-region.l.chime.aws", { method: "GET" });

        if (!res.ok) {
          throw new Error("Server error");
        }

        const data = await res.json();
        const nearestRegion = data.region;

        if (mounted) {
          setRegion((region: string) => region || nearestRegion);
        }
      } catch (e) {
        toaster.error({
          title: "Could not fetch nearest region",
          description: e instanceof Error ? e.message : "Unknown error"
        });
      }
    }

    getNearestRegion();

    return () => {
      mounted = false;
    };
  }, [setRegion, region]);

  return (
    <FormField
      field={Select}
      options={regionalOptions}
      onChange={(e: ChangeEvent<HTMLSelectElement>): void => {
        setRegion(e.target.value);
      }}
      value={region}
      label="Meeting region"
    />
  );
};

export default RegionSelection;

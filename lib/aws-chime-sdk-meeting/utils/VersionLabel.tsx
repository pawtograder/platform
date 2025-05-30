// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React from "react";
import { Versioning } from "amazon-chime-sdk-component-library-react";
import { Versioning as SDKVersioning } from "amazon-chime-sdk-js";

export const VersionLabel = () => {
  const versionTag = `${Versioning.sdkName}@${Versioning.sdkVersion}`;
  const sdkVersionTag = `${SDKVersioning.sdkName}@${SDKVersioning.sdkVersion}`;

  return (
    <span className="absolute bottom-px right-px text-[#989da5] text-[0.70rem]">
      {versionTag} | {sdkVersionTag}
    </span>
  );
};

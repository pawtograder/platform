// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React from "react";
import { StyledSpinner } from "./Styled";

const Spinner: React.FC = () => {
  return (
    <StyledSpinner>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="spinner">
        <g fill="none" fillRule="evenodd">
          <path d="M0 0H24V24H0z" />
          <g fill="currentColor">
            <path
              d="M8 0c.316 0 .571.256.571.571V4c0 .316-.255.571-.571.571-.316 0-.571-.255-.571-.571V.571C7.429.256 7.684 0 8 0z"
              transform="translate(4 4)"
            />
            <path
              d="M14.928 4c.158.273.064.623-.209.78l-2.97 1.715c-.272.158-.622.064-.78-.21-.158-.273-.064-.622.21-.78l2.969-1.714c.273-.158.622-.064.78.209z"
              opacity=".2"
              transform="translate(4 4)"
            />
            <path
              d="M12 1.072c.273.158.367.507.21.78l-1.715 2.97c-.158.273-.507.367-.78.209-.274-.158-.368-.508-.21-.78l1.714-2.97c.158-.273.508-.367.781-.21z"
              opacity=".12"
              transform="translate(4 4)"
            />
            <path
              d="M16 8c0 .316-.256.571-.571.571H12c-.316 0-.571-.255-.571-.571 0-.316.255-.571.571-.571h3.429c.315 0 .571.255.571.571z"
              opacity=".28"
              transform="translate(4 4)"
            />
            <path
              d="M12 14.928c-.273.158-.623.064-.78-.209l-1.715-2.97c-.158-.272-.064-.622.21-.78.273-.158.622-.064.78.21l1.714 2.969c.158.273.064.622-.209.78z"
              opacity=".44"
              transform="translate(4 4)"
            />
            <path
              d="M14.928 12c-.158.273-.507.367-.78.21l-2.97-1.715c-.273-.158-.367-.507-.209-.78.158-.274.508-.368.78-.21l2.97 1.714c.273.158.367.508.21.781z"
              opacity=".36"
              transform="translate(4 4)"
            />
            <path
              d="M8 16c-.316 0-.571-.256-.571-.571V12c0-.316.255-.571.571-.571.316 0 .571.255.571.571v3.429c0 .315-.255.571-.571.571z"
              opacity=".52"
              transform="translate(4 4)"
            />
            <path
              d="M1.072 12c-.158-.273-.064-.623.209-.78l2.97-1.715c.272-.158.622-.064.78.21.158.273.064.622-.21.78l-2.969 1.714c-.273.158-.622.064-.78-.209z"
              opacity=".68"
              transform="translate(4 4)"
            />
            <path
              d="M4 14.928c-.273-.158-.367-.507-.21-.78l1.715-2.97c.158-.273.507-.367.78-.209.274.158.368.508.21.78L4.78 14.72c-.158.273-.508.367-.781.21z"
              opacity=".6"
              transform="translate(4 4)"
            />
            <path
              d="M0 8c0-.316.256-.571.571-.571H4c.316 0 .571.255.571.571 0 .316-.255.571-.571.571H.571C.256 8.571 0 8.316 0 8z"
              opacity=".76"
              transform="translate(4 4)"
            />
            <path
              d="M4 1.072c.273-.158.623-.064.78.209l1.715 2.97c.158.272.064.622-.21.78-.273.158-.622.064-.78-.21L3.791 1.853c-.158-.273-.064-.622.209-.78z"
              opacity=".92"
              transform="translate(4 4)"
            />
            <path
              d="M1.072 4c.158-.273.507-.367.78-.21l2.97 1.715c.273.158.367.507.209.78-.158.274-.508.368-.78.21L1.28 4.78c-.273-.158-.367-.508-.21-.781z"
              opacity=".84"
              transform="translate(4 4)"
            />
          </g>
        </g>
      </svg>
    </StyledSpinner>
  );
};

export default Spinner;

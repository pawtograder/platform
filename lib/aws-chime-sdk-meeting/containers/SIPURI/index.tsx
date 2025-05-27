// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React, { useState, useRef, type RefObject } from "react";
import { PrimaryButton } from "amazon-chime-sdk-component-library-react";

import { StyledDiv } from "./Styled";
import { toaster } from "@/components/ui/toaster";

interface SIPProps {
  sipURI: string;
}

const SIPURI: React.FC<SIPProps> = ({ sipURI }: SIPProps) => {
  const sipUriEl: RefObject<HTMLParagraphElement> = useRef<HTMLParagraphElement>(null);
  const [isCopied, setIsCopied] = useState(false);

  const copySIPURI = (): void => {
    const selection = window.getSelection();
    if (selection && sipUriEl.current) {
      try {
        const range = document.createRange();
        range.selectNodeContents(sipUriEl.current);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("copy");
        selection.removeAllRanges();
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (error) {
        toaster.error({
          title: "Could not copy content",
          description: error instanceof Error ? error.message : "Unknown error"
        });
      }
    } else {
      toaster.error({
        title: "Could not get window selection to copy content",
        description: "Please try again later."
      });
    }
  };

  return (
    <StyledDiv>
      <div className="sip-uri-heading">SIP URI</div>
      <p ref={sipUriEl} className="sip-uri-data">
        {sipURI}
      </p>
      {document.queryCommandSupported("copy") && (
        <PrimaryButton className="btn-copy" label={!isCopied ? "Copy" : "Copied!"} onClick={copySIPURI} />
      )}
    </StyledDiv>
  );
};

export default SIPURI;

// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

"use client";

import React, { useState, type ReactNode } from "react";

type Props = { children: ReactNode };

const context = React.createContext({
  errorMessage: "",
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateErrorMessage: (_errorMessage: string) => {}
});

export function getErrorContext() {
  return context;
}

export default function ErrorProvider({ children }: Props) {
  const [errorMessage, setErrorMessage] = useState("");
  const ErrorContext = getErrorContext();

  const updateErrorMessage = (message: string): void => {
    setErrorMessage(message);
  };

  const providerValue = { errorMessage, updateErrorMessage };
  return <ErrorContext.Provider value={providerValue}>{children}</ErrorContext.Provider>;
}

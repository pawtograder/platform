"use client";

import { AppStateProvider, useAppState } from "@/lib/aws-chime-sdk-meeting/providers/AppStateProvider";

import { GlobalStyles, LoggerProvider } from "amazon-chime-sdk-component-library-react";

import { NotificationProvider } from "amazon-chime-sdk-component-library-react";
import Notifications from "@/lib/aws-chime-sdk-meeting/containers/Notifications";
import MeetingProviderWrapper from "@/lib/aws-chime-sdk-meeting/containers/MeetingProviderWrapper";
import ErrorProvider from "@/lib/aws-chime-sdk-meeting/providers/ErrorProvider";
import meetingConfig from "@/lib/aws-chime-sdk-meeting/meetingConfig";
import Router from "next/router";
import { FC, PropsWithChildren } from "react";
import { demoDarkTheme } from "@/lib/aws-chime-sdk-meeting/theme/demoTheme";
import { demoLightTheme } from "@/lib/aws-chime-sdk-meeting/theme/demoTheme";
import { ThemeProvider } from "styled-components";
const Theme: React.FC<PropsWithChildren> = ({ children }) => {
  const { theme } = useAppState();

  return (
    <ThemeProvider theme={theme === "light" ? demoLightTheme : demoDarkTheme}>
      <GlobalStyles />
      {children}
    </ThemeProvider>
  );
};
const App: FC<{ children: React.ReactNode }> = ({ children }) => (
  <LoggerProvider logger={meetingConfig.logger}>
    <AppStateProvider>
      <Theme>
        <NotificationProvider>
          <Notifications />
          <ErrorProvider>{children}</ErrorProvider>
        </NotificationProvider>
      </Theme>
    </AppStateProvider>
  </LoggerProvider>
);
export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return <App>{children}</App>;
}

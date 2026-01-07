"use client";

import { Tooltip } from "@/components/ui/tooltip";
import type { IconButtonProps } from "@chakra-ui/react";
import { ClientOnly, IconButton, Skeleton } from "@chakra-ui/react";
import type { ThemeProviderProps } from "next-themes";
import { ThemeProvider, useTheme } from "next-themes";
import * as React from "react";
import { useEffect } from "react";
import { LuMoon, LuSun, LuSunMoon } from "react-icons/lu";
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ColorModeProviderProps extends ThemeProviderProps {}

export function ColorModeProvider(props: ColorModeProviderProps) {
  return <ThemeProvider attribute="class" disableTransitionOnChange defaultTheme="light" enableSystem {...props} />;
}
const USER_COLOR_MODE_OVERRIDE_KEY = "user-color-mode";
type UserColorMode = "light" | "dark" | "system";

function readUserColorModeOverride(): UserColorMode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(USER_COLOR_MODE_OVERRIDE_KEY);
  return stored === "light" || stored === "dark" ? (stored as UserColorMode) : "system";
}

function writeUserColorModeOverride(mode: UserColorMode) {
  if (typeof window === "undefined") return;
  if (mode === "system") {
    window.localStorage.removeItem(USER_COLOR_MODE_OVERRIDE_KEY);
  } else {
    window.localStorage.setItem(USER_COLOR_MODE_OVERRIDE_KEY, mode);
  }
}

export function ColorModeWatcher() {
  // Intentional no-op: next-themes handles system changes; our hook applies overrides
  return <></>;
}
export function useColorMode() {
  const { resolvedTheme, setTheme } = useTheme();
  const [userColorMode, setUserColorMode] = React.useState<UserColorMode>("system");

  useEffect(() => {
    const override = readUserColorModeOverride();
    setUserColorMode(override);
    setTheme(override === "system" ? "system" : override);
  }, [setTheme]);

  const setColorMode = (mode: UserColorMode) => {
    setUserColorMode(mode);
    writeUserColorModeOverride(mode);
    setTheme(mode === "system" ? "system" : mode);
  };

  const toggleColorMode = () => {
    const nextMode: UserColorMode = userColorMode === "light" ? "dark" : userColorMode === "dark" ? "system" : "light";
    setColorMode(nextMode);
  };

  return { colorMode: resolvedTheme, userColorMode, setColorMode, toggleColorMode };
}

export function useColorModeValue<T>(light: T, dark: T) {
  const { colorMode } = useColorMode();
  return colorMode === "light" ? light : dark;
}

export function ColorModeIcon() {
  const { userColorMode } = useColorMode();
  if (userColorMode === "system") return <LuSunMoon />;
  return userColorMode === "light" ? <LuSun /> : <LuMoon />;
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ColorModeButtonProps extends Omit<IconButtonProps, "aria-label"> {}

export const ColorModeButton = React.forwardRef<HTMLButtonElement, ColorModeButtonProps>(
  function ColorModeButton(props, ref) {
    const { toggleColorMode, userColorMode } = useColorMode();

    return (
      <ClientOnly fallback={<Skeleton boxSize="8" />}>
        <Tooltip
          content={userColorMode === "system" ? "System mode" : userColorMode === "light" ? "Light mode" : "Dark mode"}
        >
          <IconButton
            onClick={toggleColorMode}
            variant="ghost"
            aria-label="Toggle color mode"
            size="sm"
            ref={ref}
            {...props}
            css={{ _icon: { width: "5", height: "5" } }}
          >
            <ColorModeIcon />
          </IconButton>
        </Tooltip>
      </ClientOnly>
    );
  }
);

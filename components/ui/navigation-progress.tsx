"use client";

import { Box } from "@chakra-ui/react";
import { usePathname } from "next/navigation";
import React, { createContext, useContext, useEffect, useState } from "react";

interface NavigationProgressContextType {
  isNavigating: boolean;
}

const NavigationProgressContext = createContext<NavigationProgressContextType>({
  isNavigating: false
});

export function useNavigationProgress() {
  return useContext(NavigationProgressContext);
}

function NavigationProgressBar() {
  const { isNavigating } = useNavigationProgress();

  useEffect(() => {
    if (isNavigating) {
      // Inject keyframes CSS if not already present
      const styleId = "nav-progress-keyframes";
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          @keyframes navProgress {
            0% {
              transform: translateX(-100%);
            }
            100% {
              transform: translateX(200%);
            }
          }
        `;
        document.head.appendChild(style);
      }
    }
  }, [isNavigating]);

  if (!isNavigating) {
    return null;
  }

  return (
    <Box
      position="absolute"
      bottom="0"
      left="0"
      right="0"
      height="3px"
      bg="transparent"
      overflow="hidden"
      zIndex={1000}
    >
      <Box
        position="absolute"
        top="0"
        left="0"
        height="100%"
        width="33%"
        bg="orange.600"
        style={{
          animation: "navProgress 1.5s ease-in-out infinite"
        }}
      />
    </Box>
  );
}

export function NavigationProgressProvider({ children }: { children: React.ReactNode }) {
  const [isNavigating, setIsNavigating] = useState(false);
  const pathname = usePathname();
  const [previousPathname, setPreviousPathname] = useState(pathname);

  // Detect when navigation completes (pathname changes)
  useEffect(() => {
    if (pathname !== previousPathname) {
      setIsNavigating(false);
      setPreviousPathname(pathname);
    }
  }, [pathname, previousPathname]);

  // Event delegation to catch all link clicks
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest("a");

      if (link) {
        const href = link.getAttribute("href");
        const targetAttr = link.getAttribute("target");

        // Skip if it's an external link, opens in new tab, or has preventDefault
        if (targetAttr === "_blank" || !href) {
          return;
        }

        // Check if it's an internal navigation
        try {
          const url = new URL(href, window.location.origin);
          const currentUrl = new URL(window.location.href);

          // Only trigger for internal navigation within the same origin
          if (url.origin === currentUrl.origin && url.pathname !== currentUrl.pathname) {
            setIsNavigating(true);
          }
        } catch {
          // If href is relative, check if it's different from current pathname
          if (href.startsWith("/") && href !== pathname) {
            setIsNavigating(true);
          }
        }
      }
    };

    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
    };
  }, [pathname]);

  return <NavigationProgressContext.Provider value={{ isNavigating }}>{children}</NavigationProgressContext.Provider>;
}

export { NavigationProgressBar };

"use client";

import { Box } from "@chakra-ui/react";
import { usePathname, useSearchParams } from "next/navigation";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";

interface NavigationProgressContextType {
  isNavigating: boolean;
  startNavigation: () => void;
}

const NavigationProgressContext = createContext<NavigationProgressContextType>({
  isNavigating: false,
  startNavigation: () => {}
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
  const searchParams = useSearchParams();
  const [previousPathname, setPreviousPathname] = useState(pathname);
  const [previousSearchParams, setPreviousSearchParams] = useState(searchParams.toString());
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Helper to clear navigation state
  const clearNavigation = () => {
    setIsNavigating(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  // Helper to start navigation with timeout fallback
  const startNavigation = () => {
    setIsNavigating(true);
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    // Set a timeout to reset loading state if navigation doesn't complete
    timeoutRef.current = setTimeout(() => {
      setIsNavigating(false);
      timeoutRef.current = null;
    }, 5000); // 5 second fallback
  };

  // Detect when navigation completes (pathname OR searchParams changes)
  useEffect(() => {
    const searchParamsString = searchParams.toString();
    const pathnameChanged = pathname !== previousPathname;
    const searchParamsChanged = searchParamsString !== previousSearchParams;

    if (pathnameChanged || searchParamsChanged) {
      clearNavigation();
      setPreviousPathname(pathname);
      setPreviousSearchParams(searchParamsString);
    }
  }, [pathname, searchParams, previousPathname, previousSearchParams]);

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

          // Trigger for internal navigation (pathname or search params change)
          if (url.origin === currentUrl.origin) {
            const pathnameChanged = url.pathname !== currentUrl.pathname;
            const searchParamsChanged = url.search !== currentUrl.search;
            if (pathnameChanged || searchParamsChanged) {
              startNavigation();
            }
          }
        } catch {
          // If href is relative, check if it's different from current pathname
          if (href.startsWith("/")) {
            const [path, search] = href.split("?");
            const pathnameChanged = path !== pathname;
            const searchParamsChanged = search !== undefined && search !== searchParams.toString();
            if (pathnameChanged || searchParamsChanged) {
              startNavigation();
            }
          }
        }
      }
    };

    // Listen for browser back/forward navigation
    const handlePopState = () => {
      clearNavigation();
    };

    document.addEventListener("click", handleClick, true);
    window.addEventListener("popstate", handlePopState);

    return () => {
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("popstate", handlePopState);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [pathname, searchParams]);

  return (
    <NavigationProgressContext.Provider value={{ isNavigating, startNavigation }}>
      {children}
    </NavigationProgressContext.Provider>
  );
}

export { NavigationProgressBar };

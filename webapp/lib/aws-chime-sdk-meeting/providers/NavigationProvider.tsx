'use client'
// Copyright 2020-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import React, {
  useState,
  useContext,
  useEffect,
  useRef,
  ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useMeetingManager } from 'amazon-chime-sdk-component-library-react';

import routes from '../constants/routes';

export type NavigationContextType = {
  showNavbar: boolean;
  showRoster: boolean;
  toggleRoster: () => void;
  toggleNavbar: () => void;
  openRoster: () => void;
  closeRoster: () => void;
  openNavbar: () => void;
  closeNavbar: () => void;
  showChat: boolean;
  toggleChat: () => void;
};

type Props = {
  children: ReactNode;
};

const NavigationContext = React.createContext<NavigationContextType | null>(
  null
);

const isDesktop = () => true; //window.innerWidth > 768; //TODO

const NavigationProvider = ({ children }: Props) => {
  const [showNavbar, setShowNavbar] = useState(() => isDesktop());
  const [showRoster, setShowRoster] = useState(() => isDesktop());
  const [showChat, setShowChat] = useState(() => isDesktop());
  const isDesktopView = useRef(isDesktop());

  const pathname = usePathname();
  const meetingManager = useMeetingManager();

  useEffect(() => {
    if (pathname.includes(routes.MEETING)) {
      return () => {
        meetingManager.leave();
      };
    }
  }, [pathname]);

  useEffect(() => {
    const handler = () => {
      const isResizeDesktop = isDesktop();
      if (isDesktopView.current === isResizeDesktop) {
        return;
      }

      isDesktopView.current = isResizeDesktop;

      if (!isResizeDesktop) {
        setShowNavbar(false);
        setShowRoster(false);
        setShowChat(false);
      } else {
        setShowNavbar(true);
      }
    };

    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const toggleRoster = (): void => {
    setShowRoster(!showRoster);
  };

  const toggleNavbar = (): void => {
    setShowNavbar(!showNavbar);
  };

  const openNavbar = (): void => {
    setShowNavbar(true);
  };

  const closeNavbar = (): void => {
    setShowNavbar(false);
  };

  const openRoster = (): void => {
    setShowRoster(true);
  };

  const closeRoster = (): void => {
    setShowRoster(false);
  };

  const toggleChat = (): void => {
    setShowChat(!showChat);
  };

  const providerValue = {
    showNavbar,
    showRoster,
    toggleRoster,
    toggleNavbar,
    openRoster,
    closeRoster,
    openNavbar,
    closeNavbar,
    showChat,
    toggleChat,
  };
  return (
    <NavigationContext.Provider value={providerValue}>
      {children}
    </NavigationContext.Provider>
  );
};

const useNavigation = (): NavigationContextType => {
  const context = useContext(NavigationContext);
  if (!context) {
    throw Error('Use useNavigation in NavigationProvider');
  }
  return context;
};

export { NavigationProvider, useNavigation };

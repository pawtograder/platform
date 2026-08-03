"use client";

import { Toaster as ChakraToaster, Portal, Spinner, Stack, Toast, createToaster } from "@chakra-ui/react";

export const toaster = createToaster({
  placement: "bottom-end",
  pauseOnPageIdle: true
});

export const Toaster = () => {
  return (
    <Portal>
      {/*
        `aria-label` is set explicitly because zag's default group label concatenates the
        placement token and the focus hotkey into the accessible name — VoiceOver reads the
        region as "bottom-end Notifications alt+T". Passing `aria-label` here wins over the
        generated one (Ark merges caller props last). See issue #881.
      */}
      <ChakraToaster
        toaster={toaster}
        insetInline={{ mdDown: "4" }}
        aria-label="Notifications"
        data-visual-test="removed"
      >
        {(toast) => (
          <Toast.Root width={{ md: "sm" }}>
            {toast.type === "loading" ? <Spinner size="sm" color="blue.solid" /> : <Toast.Indicator />}
            <Stack gap="1" flex="1" maxWidth="100%">
              {toast.title && <Toast.Title>{toast.title}</Toast.Title>}
              {toast.description && <Toast.Description>{toast.description}</Toast.Description>}
            </Stack>
            {toast.action && <Toast.ActionTrigger>{toast.action.label}</Toast.ActionTrigger>}
            {toast.meta?.closable && <Toast.CloseTrigger />}
          </Toast.Root>
        )}
      </ChakraToaster>
    </Portal>
  );
};

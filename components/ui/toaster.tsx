"use client";

import { bugReportingAvailable } from "@/lib/bugReport/availability";
import { currentTaskErrorEventId } from "@/lib/bugReport/errorEventLink";
import { openReportDialog } from "@/lib/bugReport/reportDialog";
import { Toaster as ChakraToaster, Portal, Spinner, Stack, Toast, createToaster } from "@chakra-ui/react";

export const toaster = createToaster({
  placement: "bottom-end",
  pauseOnPageIdle: true
});

type ToastOptions = Parameters<typeof toaster.create>[0];

/**
 * Every error toast gets a "Report this" action that opens the bug report dialog linked to
 * the Sentry event behind the error. The link is resolved when the toast is created: an
 * explicit `meta.sentryEventId`, else the error event captured earlier in the same task
 * (the usual `Sentry.captureException(e); toaster.error(...)` pattern). If there is none,
 * the dialog captures a stand-in event when the report is submitted, never on the click
 * itself, so Cancel sends nothing. Callers that set their own `action`, or pass
 * `meta: { reportable: false }`, keep their toast as is, and so does every toast on a
 * deployment that can't send reports (no Sentry DSN).
 */
function withReportAction(options: ToastOptions): ToastOptions {
  if (options.action || options.meta?.reportable === false || !bugReportingAvailable()) return options;
  const linked: string | undefined = options.meta?.sentryEventId ?? currentTaskErrorEventId();
  return {
    ...options,
    action: {
      label: "Report this",
      onClick: () => {
        openReportDialog(linked ? { eventId: linked } : { linkStandInEvent: true });
      }
    }
  };
}

const createToast = toaster.create;
const createErrorToast = toaster.error;
const updateToast = toaster.update;
toaster.create = (options) => createToast(options.type === "error" ? withReportAction(options) : options);
toaster.error = (options) => createErrorToast(withReportAction(options));
toaster.update = (id, options) => updateToast(id, options.type === "error" ? withReportAction(options) : options);

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

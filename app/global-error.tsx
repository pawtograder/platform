"use client";
import { getLastKnownReportContext } from "@/lib/bugReport/reportContext";
import { submitReport, type SubmitReportResult } from "@/lib/bugReport/submitFeedback";
import * as Sentry from "@sentry/nextjs";
import { useEffect, useId, useState, type FormEvent } from "react";

/**
 * Plain-HTML bug report form. This page renders its own `<html>` outside the root layout,
 * so Chakra and the report dialog are not available here.
 */
function CrashReportForm({ errorID }: { errorID: string }) {
  const [state, setState] = useState<"editing" | "submitting" | SubmitReportResult>("editing");
  const descriptionId = useId();
  const contactId = useId();

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setState("submitting");
    try {
      setState(
        await submitReport({
          description: String(form.get("description") ?? ""),
          contactOk: form.get("contact_ok") === "on",
          eventId: errorID,
          context: getLastKnownReportContext()
        })
      );
    } catch {
      setState({ status: "error", message: "The report did not go through. Try again." });
    }
  };

  if (typeof state === "object" && state.status === "sent") {
    return (
      <p role="status" style={{ fontSize: "1rem", color: "#22543d", margin: "0 0 1.5rem 0" }}>
        Thanks, your report was sent. The developers will look into it.
      </p>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Report this error"
      data-testid="global-error-report-form"
      style={{ textAlign: "left", margin: "0 0 1.5rem 0" }}
    >
      <p style={{ fontSize: "1rem", color: "#4a5568", lineHeight: "1.6", margin: "0 0 0.75rem 0" }}>
        Tell us what you were doing when this happened. The report is linked to error ID{" "}
        <code data-testid="global-error-event-id">{errorID}</code> and includes your user ID and course role, not your
        name or email.
      </p>
      <label htmlFor={descriptionId} style={{ display: "block", fontWeight: 600, color: "#1a202c" }}>
        What happened?
      </label>
      <textarea
        id={descriptionId}
        name="description"
        required
        rows={4}
        disabled={state === "submitting"}
        style={{
          width: "100%",
          boxSizing: "border-box",
          margin: "0.25rem 0 0.75rem 0",
          padding: "0.5rem",
          borderRadius: "6px",
          border: "1px solid #a0aec0",
          font: "inherit"
        }}
      />
      <label htmlFor={contactId} style={{ display: "flex", gap: "0.5rem", alignItems: "center", color: "#1a202c" }}>
        <input id={contactId} type="checkbox" name="contact_ok" disabled={state === "submitting"} />
        You may contact me about this
      </label>
      {typeof state === "object" && state.status === "rate_limited" && (
        <p role="alert" style={{ color: "#9b2c2c", margin: "0.75rem 0 0 0" }}>
          Too many reports are being sent right now. Try again later.
        </p>
      )}
      {typeof state === "object" && state.status === "error" && (
        <p role="alert" style={{ color: "#9b2c2c", margin: "0.75rem 0 0 0" }}>
          {state.message}
        </p>
      )}
      <button
        type="submit"
        className="error-button-primary"
        disabled={state === "submitting"}
        style={{ marginTop: "0.75rem" }}
      >
        {state === "submitting" ? "Sending" : "Send report"}
      </button>
    </form>
  );
}

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const [errorID, setErrorID] = useState<string | undefined>(undefined);

  // Call Sentry once per error
  useEffect(() => {
    setErrorID(Sentry.captureException(error));
  }, [error]);

  const handleGoBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = "/";
    }
  };

  return (
    <html>
      <head>
        <style>{`
          .error-button-primary {
            background-color: #3182ce;
            color: white;
            padding: 0.75rem 1.5rem;
            border-radius: 8px;
            border: none;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: background-color 0.2s;
            margin-right: 1rem;
          }
          
          .error-button-primary:hover {
            background-color: #2c5aa0;
          }
          
          .error-button-secondary {
            background-color: #e2e8f0;
            color: #4a5568;
            padding: 0.75rem 1.5rem;
            border-radius: 8px;
            border: none;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: background-color 0.2s;
          }
          
          .error-button-secondary:hover {
            background-color: #cbd5e0;
          }
        `}</style>
      </head>
      <body>
        <div
          style={{
            minHeight: "100vh",
            backgroundImage: "url('/error-background.jpg')",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
            fontFamily: "system-ui, -apple-system, sans-serif"
          }}
        >
          <div
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.95)",
              backdropFilter: "blur(10px)",
              borderRadius: "16px",
              padding: "3rem",
              maxWidth: "500px",
              textAlign: "center",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
            }}
          >
            <div style={{ fontSize: "4rem", marginBottom: "1rem" }}>🐾</div>
            <h1
              style={{
                fontSize: "2.5rem",
                fontWeight: "bold",
                color: "#1a202c",
                marginBottom: "1rem",
                margin: "0 0 1rem 0"
              }}
            >
              Oops! We&apos;ve Hit a Ruff Patch
            </h1>
            <p
              style={{
                fontSize: "1.125rem",
                color: "#4a5568",
                marginBottom: "1.5rem",
                lineHeight: "1.6",
                margin: "0 0 1.5rem 0"
              }}
            >
              It looks like a husky encountered a bug and buried it... a little too well! This error has been
              automatically reported to our pack of developers.
            </p>
            {errorID && <CrashReportForm errorID={errorID} />}
            <button type="button" onClick={() => window.location.reload()} className="error-button-primary">
              Try Again
            </button>
            <button type="button" onClick={handleGoBack} className="error-button-secondary">
              Go Back
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

"use client";
import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { usePostHog } from "posthog-js/react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const [errorID, setErrorID] = useState<string | undefined>(undefined);
  const posthog = usePostHog();
  useEffect(() => {
    posthog.captureException(error);
    setErrorID(Sentry.captureException(error));
  }, [error, posthog]);

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
            {errorID && (
              <p style={{ fontSize: "1rem", color: "#4a5568", marginBottom: "1.5rem", lineHeight: "1.6" }}>
                If you continue to experience this error, please{" "}
                <a
                  href={`https://github.com/pawtograder/platform/issues/new?labels=bug&template=bug_report.md`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  report it on our issue tracker
                </a>
                , and include the error ID: {errorID}. Any additional information that you can provide about how you
                reached this error will help us fix it faster.
              </p>
            )}
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

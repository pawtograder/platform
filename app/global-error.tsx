"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
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
            <button
              onClick={() => window.location.reload()}
              style={{
                backgroundColor: "#3182ce",
                color: "white",
                padding: "0.75rem 1.5rem",
                borderRadius: "8px",
                border: "none",
                fontSize: "1rem",
                fontWeight: "600",
                cursor: "pointer",
                transition: "background-color 0.2s",
                marginRight: "1rem"
              }}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#2c5aa0")}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "#3182ce")}
            >
              Try Again
            </button>
            <button
              onClick={() => window.history.back()}
              style={{
                backgroundColor: "#e2e8f0",
                color: "#4a5568",
                padding: "0.75rem 1.5rem",
                borderRadius: "8px",
                border: "none",
                fontSize: "1rem",
                fontWeight: "600",
                cursor: "pointer",
                transition: "background-color 0.2s"
              }}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#cbd5e0")}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "#e2e8f0")}
            >
              Go Back
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

"use client";

import qrcodegen from "nayuki-qr-code-generator";

// Helper function to convert QR code to SVG string
function toSvgString(qr: qrcodegen.QrCode, border: number, lightColor: string, darkColor: string): string {
  if (border < 0) throw new RangeError("Border must be non-negative");
  let parts: Array<string> = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${qr.size + border * 2} ${qr.size + border * 2}" stroke="none">
	<rect width="100%" height="100%" fill="${lightColor}"/>
	<path d="${parts.join(" ")}" fill="${darkColor}"/>
</svg>
`;
}

/**
 * Hook to generate QR code as a data URL
 * Generates QR code SVG and converts it to a data URL that can be used directly in img tags
 * Generates fresh every time the component loads - no memoization
 */
export function usePollQrCode(courseId: string, pollUrl: string, lightColor: string, darkColor: string) {
  if (!pollUrl || !courseId) {
    return { qrCodeUrl: null, isLoading: false, error: null };
  }

  try {
    // Generate QR code SVG
    const QRC = qrcodegen.QrCode;
    const qr = QRC.encodeText(pollUrl, QRC.Ecc.MEDIUM);
    const svgString = toSvgString(qr, 4, lightColor, darkColor);

    // Convert SVG string to data URL
    const encodedSvg = encodeURIComponent(svgString);
    const qrCodeUrl = `data:image/svg+xml;charset=utf-8,${encodedSvg}`;

    return { qrCodeUrl, isLoading: false, error: null };
  } catch (err) {
    console.error("Error generating QR code:", err);
    return {
      qrCodeUrl: null,
      isLoading: false,
      error: err instanceof Error ? err : new Error("Failed to generate QR code")
    };
  }
}

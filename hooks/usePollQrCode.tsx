"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/utils/supabase/client";
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
 * Hook to manage QR code generation and storage for polls
 * Generates QR code SVG and uploads to Supabase storage if it doesn't exist
 */
export function usePollQrCode(pollId: string, pollUrl: string, lightColor: string, darkColor: string) {
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const storagePath = useMemo(() => `polls/${pollId}/qr-code.svg`, [pollId]);

  useEffect(() => {
    if (!pollUrl || !pollId) {
      setIsLoading(false);
      return;
    }

    const uploadQrCode = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const supabase = createClient();

        // Get public URL first (this always works, doesn't check if file exists)
        const { data: existingUrlData } = supabase.storage
          .from("uploads")
          .getPublicUrl(storagePath);

        // Try to fetch the file to see if it exists
        const { error: checkError } = await supabase.storage
          .from("uploads")
          .download(storagePath);

        if (!checkError) {
          // File exists, use the public URL
          setQrCodeUrl(existingUrlData.publicUrl);
          setIsLoading(false);
          return;
        }

        // Generate QR code SVG
        const QRC = qrcodegen.QrCode;
        const qr = QRC.encodeText(pollUrl, QRC.Ecc.MEDIUM);
        const svgString = toSvgString(qr, 4, lightColor, darkColor);

        // Convert SVG string to Blob
        const svgBlob = new Blob([svgString], { type: "image/svg+xml" });

        // Upload to Supabase storage
        const { error: uploadError, data: uploadData } = await supabase.storage
          .from("uploads")
          .upload(storagePath, svgBlob, {
            contentType: "image/svg+xml",
            upsert: true // Replace if exists
          });

        if (uploadError) {
          console.error("Upload error details:", uploadError);
          throw new Error(`Failed to upload QR code: ${uploadError.message}`);
        }

        // Verify upload was successful
        if (!uploadData) {
          throw new Error("Upload succeeded but no data returned");
        }

        // Get public URL using Supabase's method after successful upload
        const { data: urlData } = supabase.storage
          .from("uploads")
          .getPublicUrl(storagePath);
        
        console.log("QR code uploaded successfully, public URL:", urlData.publicUrl);
        setQrCodeUrl(urlData.publicUrl);
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to generate QR code"));
        console.error("Error uploading QR code:", err);
      } finally {
        setIsLoading(false);
      }
    };

    uploadQrCode();
  }, [pollId, pollUrl, lightColor, darkColor, storagePath]);

  return { qrCodeUrl, isLoading, error };
}


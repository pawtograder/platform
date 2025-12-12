"use client";

import { useState } from "react";
import { DialogRoot, DialogContent, DialogBody, DialogCloseTrigger } from "@/components/ui/dialog";

type QrCodeProps = {
  qrCodeUrl: string | undefined;
  size?: string;
  isFullscreen?: boolean;
};

export default function QrCode({ qrCodeUrl, size = "40px", isFullscreen = false }: QrCodeProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  if (!qrCodeUrl) {
    return null;
  }

  return (
    <>
      {/* QR Code Thumbnail */}
      <button
        type="button"
        onClick={() => setIsModalOpen(true)}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = "scale(1.1)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = "scale(1)";
        }}
        aria-label="Open QR code modal"
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: "inline-block",
          cursor: "pointer",
          transition: "transform 0.2s",
          padding: 0,
          border: "none",
          background: "transparent"
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={qrCodeUrl}
          alt="QR Code"
          style={{
            width: "100%",
            height: "100%",
            display: "block"
          }}
        />
      </button>

      {/* Full Screen Modal */}
      <DialogRoot open={isModalOpen} onOpenChange={(e) => setIsModalOpen(e.open)} closeOnInteractOutside={true}>
        <DialogContent bg="transparent" boxShadow="none" w="fit-content" maxW="none" p={0} portalled={!isFullscreen}>
          <DialogBody p={0} position="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrCodeUrl}
              alt="QR Code"
              style={{
                width: "min(75vh, 75vw)",
                height: "min(75vh, 75vw)"
              }}
            />
            <DialogCloseTrigger
              position="absolute"
              top="8px"
              right="8px"
              bg="black"
              color="white"
              borderRadius="full"
              w="40px"
              h="40px"
              _hover={{ bg: "gray.800" }}
            />
          </DialogBody>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

"use client";

import { useState } from "react";
import { Box } from "@chakra-ui/react";
import {
    DialogRoot,
    DialogContent,
    DialogBody,
    DialogCloseTrigger
} from "@/components/ui/dialog";

type QrCodeProps = {
    qrCodeUrl: string | null;
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={qrCodeUrl}
                alt="QR Code"
                onClick={() => setIsModalOpen(true)}
                style={{
                    width: size,
                    height: size,
                    flexShrink: 0,
                    display: "inline-block",
                    cursor: "pointer",
                    transition: "transform 0.2s"
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "scale(1.1)";
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "scale(1)";
                }}
            />

            {/* Full Screen Modal */}
            <DialogRoot open={isModalOpen} onOpenChange={(e) => setIsModalOpen(e.open)}>
                <DialogContent
                    bg="transparent"
                    boxShadow="none"
                    portalled={!isFullscreen}
                >
                    <DialogBody p={0} display="flex" alignItems="center" justifyContent="center">
                        <Box position="relative" display="inline-block">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={qrCodeUrl}
                                alt="QR Code"
                                style={{
                                    width: "min(70vw, 500px)",
                                    height: "min(70vw, 500px)",
                                    maxWidth: "500px",
                                    maxHeight: "500px",
                                    objectFit: "contain"
                                }}
                            />
                            <DialogCloseTrigger
                                position="absolute"
                                top="8px"
                                right="8px"
                                bg="black"
                                color="white"
                                borderRadius="full"
                                _hover={{ bg: "gray.800" }}
                            />
                        </Box>
                    </DialogBody>
                </DialogContent>
            </DialogRoot>
        </>
    );
}


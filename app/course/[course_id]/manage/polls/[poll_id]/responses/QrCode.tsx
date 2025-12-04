"use client";

import { useState } from "react";
import { VStack, Text } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import {
    DialogRoot,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogBody,
    DialogCloseTrigger
} from "@/components/ui/dialog";

type QrCodeProps = {
    qrCodeUrl: string | null;
    pollUrl: string;
    size?: string;
    isFullscreen?: boolean;
};

export default function QrCode({ qrCodeUrl, pollUrl, size = "40px", isFullscreen = false }: QrCodeProps) {
    const [isModalOpen, setIsModalOpen] = useState(false);

    const textColor = useColorModeValue("#1A202C", "#FFFFFF");
    const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
    const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
    const headerBgColor = useColorModeValue("#F8F9FA", "#2D2D2D");
    const mutedTextColor = useColorModeValue("#6B7280", "#A0AEC0");

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
                    maxW="2xl"
                    w="90vw"
                    maxH="90vh"
                    bg={bgColor}
                    borderColor={borderColor}
                    borderRadius="lg"
                    className="flex flex-col"
                    portalled={!isFullscreen}
                >

                    <DialogCloseTrigger />
                    <DialogBody p={6} overflow="auto" display="flex" alignItems="center" justifyContent="center">
                        <VStack gap={4} align="center">
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
                        </VStack>
                    </DialogBody>
                </DialogContent>
            </DialogRoot>
        </>
    );
}


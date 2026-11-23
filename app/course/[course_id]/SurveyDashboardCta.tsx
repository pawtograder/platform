import { Box } from "@chakra-ui/react";
import Link from "next/link";

export default function SurveyDashboardCta({
  href,
  label,
  ariaLabel,
  colorPalette
}: {
  href: string;
  label: string;
  ariaLabel: string;
  colorPalette: "blue" | "red" | "yellow" | "green" | "gray";
}) {
  return (
    <Link href={href} aria-label={ariaLabel} style={{ textDecoration: "none" }}>
      <Box
        as="span"
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
        h="8"
        px="3"
        fontSize="sm"
        fontWeight="medium"
        borderRadius="l2"
        colorPalette={colorPalette}
        bg="colorPalette.solid"
        color="colorPalette.contrast"
        _hover={{ opacity: 0.92 }}
        _active={{ opacity: 0.88 }}
      >
        {label}
      </Box>
    </Link>
  );
}

import { Link as ChakraLink } from "@chakra-ui/react"
import NextLink from "next/link"

export default function Link({ href, children, variant, colorPalette, prefetch, target}: { href: string, children: React.ReactNode, variant?: 'underline' | 'plain' , colorPalette?: 'gray' | 'blue' | 'red' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'teal' | 'cyan' | 'black' | 'white' | 'accent', prefetch?: null|true|false, target?: '_blank' | '_self' }) {
    return <NextLink href={href} passHref legacyBehavior prefetch={prefetch === undefined ? null : prefetch}>
        <ChakraLink target={target} color={colorPalette} variant={variant}>{children}</ChakraLink>
    </NextLink>
}


// 'use client'

import {
    Box,
    BoxProps,
    Flex,
    FlexProps,
    HStack,
    Text
} from '@chakra-ui/react'


import React from 'react'
import { IconType } from 'react-icons'
import {
    FiCompass,
    FiHome,
    FiSettings,
    FiStar,
    FiTrendingUp
} from 'react-icons/fi'
import UserMenu from '../UserMenu'

interface LinkItemProps {
    name: string
    icon: IconType
}

interface NavItemProps extends FlexProps {
    icon: IconType
    children: React.ReactNode
}

const LinkItems: Array<LinkItemProps> = [
    { name: 'Assignments', icon: FiCompass },
    { name: 'Grades', icon: FiStar },
    // { name: 'Trending', icon: FiTrendingUp },
    // { name: 'Explore', icon: FiCompass },
    // { name: 'Favourites', icon: FiStar },
    { name: 'Settings', icon: FiSettings },
]

const SidebarContent = ({  ...rest }: BoxProps) => {
    return (
        <Box
            transition="3s ease"
            bg='gray.40'
            borderRight="1px"
            borderRightColor='gray.200'
            w={{ base: 'full', md: 60 }}
            pos="fixed"
            h="full"
            {...rest}>
            <Flex h="20" alignItems="center" mx="8" justifyContent="space-between">
                <Text fontSize="2xl" fontFamily="monospace" fontWeight="bold">
                    Course Links
                </Text>
            </Flex>
            {LinkItems.map((link) => (
                <NavItem key={link.name} icon={link.icon}>
                    {link.name}
                </NavItem>
            ))}
        </Box>
    )
}

const NavItem = ({ icon, children, ...rest }: NavItemProps) => {
    return (
        <Box
            as="a"
            style={{ textDecoration: 'none' }}
            _focus={{ boxShadow: 'none' }}>
            <Flex
                align="center"
                p="4"
                mx="4"
                borderRadius="lg"
                role="group"
                cursor="pointer"
                _hover={{
                    bg: 'cyan.400',
                    color: 'black',
                }}
                {...rest}>
                <HStack>
                    {React.createElement(icon)}
                    {/* <Icon
                        mr="4"
                        fontSize="16"
                        _groupHover={{
                            color: 'white',
                        }}
                        as={icon}
                    /> */}
                    {children}</HStack>
            </Flex>
        </Box>
    )
}

const ProtectedLayout = ({ children }: Readonly<{
    children: React.ReactNode;
}>) => {

    // const { open, onOpen, onClose } = useDisclosure()
    return (
        <Box minH="100vh">
            <SidebarContent display={{ base: 'none', md: 'block' }} />
            {/* mobilenav */}
            <Box ml={{ base: 0, md: 60 }} p="4">
                {children}
            </Box>
        </Box>
    )
}

export default ProtectedLayout
// 'use client'

import {
    Box,
    Flex,
    FlexProps,
    Text
} from '@chakra-ui/react'


import React from 'react'
import { IconType } from 'react-icons'
import UserMenu from './UserMenu'

const TopNavBar = ({ ...rest }: FlexProps) => {
    return (
        <Flex
            px={{ base: 4, md: 4 }}
            height="20"
            alignItems="center"
            bg='white'
            borderBottomWidth="1px"
            borderBottomColor='gray.200'
            justifyContent={{ base: 'space-between', md: 'flex-end' }}
            {...rest}>
            <UserMenu />
        </Flex>
    )
}

const ProtectedLayout = ({ children }: Readonly<{
    children: React.ReactNode;
}>) => {

    return (
        <Box minH="100vh">
            <TopNavBar />
            <Box ml={{ base: 0 }} p="4">
                {children}
            </Box>
        </Box>
    )
}

export default ProtectedLayout
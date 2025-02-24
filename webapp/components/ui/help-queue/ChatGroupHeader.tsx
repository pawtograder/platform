import { HStack, Icon, Text } from '@chakra-ui/react'

interface Props {
  icon: React.ElementType
  children: React.ReactNode
}

export const ChatGroupHeader = (props: Props) => {
  const { icon, children } = props
  return (
    <HStack color="fg.muted">
      <Icon as={icon} />
      <Text fontWeight="semibold" textTransform="uppercase" fontSize="xs">
        {children}
      </Text>
    </HStack>
  )
}

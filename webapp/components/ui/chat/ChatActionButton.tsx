import { Button, ButtonProps, Icon } from '@chakra-ui/react'

export function ChatActionButton(props: ButtonProps & { icon: React.ElementType }) {
  const { icon, children, ...rest } = props
  return (
    <Button
      bg="bg"
      size="sm"
      variant="secondary"
      {...rest}
      leftIcon={<Icon as={icon} color="fg.subtle" />}
    >
      {children}
    </Button>
  )
}

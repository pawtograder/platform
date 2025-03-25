import { Button, IconButton, Text } from "@chakra-ui/react"
import { Icon } from "@chakra-ui/react"
import { PopoverRoot, PopoverTrigger, PopoverContent, PopoverHeader, PopoverBody } from "./popover"
import { BsCheck, BsX } from "react-icons/bs"
import { useState } from "react"

export const PopConfirm = ({ triggerLabel, trigger, confirmHeader, confirmText, onConfirm, onCancel }: { triggerLabel: string, trigger: React.ReactNode, confirmHeader: string, confirmText: string, onConfirm: () => void, onCancel: () => void }) => {
    const [isOpen, setIsOpen] = useState(false);
    return (<PopoverRoot
        closeOnInteractOutside={false}
        open={isOpen} onOpenChange={(details) => setIsOpen(details.open)}>
        <PopoverTrigger aria-label={triggerLabel} asChild
        >
            {trigger}
        </PopoverTrigger>
        <PopoverContent>
            <PopoverHeader>{confirmHeader}</PopoverHeader>
            <PopoverBody>
                <Text>{confirmText}</Text>
                <IconButton onClick={() => { onConfirm(); setIsOpen(false); }} aria-label="Confirm"><Icon as={BsCheck} /></IconButton>
                <IconButton onClick={() => { onCancel(); setIsOpen(false); }} aria-label="Cancel" variant="ghost"><Icon as={BsX} /></IconButton>
            </PopoverBody>
        </PopoverContent>
    </PopoverRoot>)
}
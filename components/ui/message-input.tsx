"use client";
import data from "@emoji-mart/data";
import { useCallback, useRef, useState } from "react";
import { IGif } from "@giphy/js-types";
import MDEditor from "@uiw/react-md-editor";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { Box, Button, Field, HStack, Textarea, VStack, Text } from "@chakra-ui/react";
import Picker from "@emoji-mart/react";
import { FaPaperclip, FaSmile, FaUserSecret } from "react-icons/fa";
import { TbMathFunction } from "react-icons/tb";
import { Checkbox } from "./checkbox";
import GiphyPicker from "./giphy-picker";
import Markdown from "@/components/ui/markdown";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { Tooltip } from "./tooltip";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { toaster } from "./toaster";
type MessageInputProps = React.ComponentProps<typeof MDEditor> & {
  defaultSingleLine?: boolean;
  sendMessage: (message: string, profile_id: string, close?: boolean) => Promise<void>;
  enableFilePicker?: boolean;
  enableGiphyPicker?: boolean;
  enableEmojiPicker?: boolean;
  enableAnonymousModeToggle?: boolean;
  otherButtons?: React.ReactNode | React.ReactNode[];
  sendButtonText?: string;
  placeholder?: string;
  allowEmptyMessage?: boolean;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
  onClose?: () => void;
  closeButtonText?: string;
  ariaLabel?: string;
};
export default function MessageInput(props: MessageInputProps) {
  const {
    defaultSingleLine,
    sendMessage,
    enableFilePicker,
    enableGiphyPicker,
    enableEmojiPicker,
    enableAnonymousModeToggle,
    otherButtons,
    sendButtonText,
    placeholder,
    allowEmptyMessage,
    textAreaRef,
    onClose,
    closeButtonText,
    value: initialValue,
    ariaLabel,
    ...editorProps
  } = props;
  const { course_id } = useParams();
  const [enterToSend, setEnterToSend] = useState(true);
  const [value, setValue] = useState(initialValue);
  const [singleLine] = useState(defaultSingleLine ?? false);
  const [, setFocused] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGiphyPicker, setShowGiphyPicker] = useState(false);
  const [anonymousMode, setAnonymousMode] = useState(false);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onChange = useCallback(
    (value: string) => {
      setValue(value);
      props.onChange?.(value);
    },
    [props]
  );
  const { public_profile_id, private_profile_id } = useClassProfiles();
  const public_profile = useUserProfile(public_profile_id);
  const private_profile = useUserProfile(private_profile_id);
  const profile_id = anonymousMode ? public_profile_id! : private_profile_id!;

  const toggleEmojiPicker = () => setShowEmojiPicker(!showEmojiPicker);
  const toggleAnonymousMode = () => setAnonymousMode(!anonymousMode);
  const fileUpload = useCallback(
    async (file: File) => {
      const supabase = createClient();
      const uuid = crypto.randomUUID();
      const fileName = file.name.replace(/[^a-zA-Z0-9-_\.]/g, "_");

      const { error } = await supabase.storage
        .from("uploads")
        .upload(`${course_id}/discussion/${uuid}/${fileName}`, file);
      if (error) {
        toaster.error({
          title: "Error uploading image: " + error.name,
          description: error.message
        });
        return;
      }
      const urlEncodedFilename = encodeURIComponent(fileName);

      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/uploads/${course_id}/discussion/${uuid}/${urlEncodedFilename}`;
      sendMessage(`Attachment: [${file.name}](${url})`, profile_id, false);
      return url;
    },
    [course_id, profile_id, sendMessage]
  );

  const attachFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }
      fileUpload(file);
    },
    [fileUpload]
  );
  const onFileTransfer = useCallback(
    async (dataTransfer: DataTransfer) => {
      const files: File[] = [];
      for (let index = 0; index < dataTransfer.items.length; index += 1) {
        const file = dataTransfer.files.item(index);
        if (file) {
          files.push(file);
        }
      }
      const insertedMarkdowns = await Promise.all(
        files.map(async (file) => {
          const url = await fileUpload(file);
          const isImage = file.type.startsWith("image/");
          const insertedMarkdown = isImage ? `![](${url})` : `[${file.name}](${url})`;
          return insertedMarkdown;
        })
      );
      sendMessage("Attachment: " + insertedMarkdowns.join("\n"), profile_id, false);
    },
    [profile_id, fileUpload, sendMessage]
  );
  if (singleLine) {
    return (
      <VStack align="stretch" spaceY="0" p="0" gap="2" w="100%">
        {showMarkdownPreview && (
          <Box width="100%" p="2" bg="bg.muted" border={"1px solid"} borderColor="border.subtle" rounded="md" m="0">
            <Markdown>{value}</Markdown>
          </Box>
        )}

        <Textarea
          p="2"
          width="100%"
          disabled={isSending}
          aria-label={ariaLabel ?? placeholder ?? "Reply..."}
          placeholder={placeholder ?? "Reply..."}
          m="0"
          ref={textAreaRef}
          onDragEnter={(e) => {
            const target = e.target as HTMLElement;
            target.style.border = "2px dashed #999";
            target.style.backgroundColor = "rgba(0, 0, 0, 0.05)";
            e.preventDefault();
            e.stopPropagation();
          }}
          onDragLeave={(e) => {
            const target = e.target as HTMLElement;
            target.style.border = "none";
            target.style.backgroundColor = "transparent";
            e.preventDefault();
            e.stopPropagation();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await onFileTransfer(e.dataTransfer);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          variant="subtle"
          autoresize
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(e.shiftKey || e.metaKey || !enterToSend)) {
              e.preventDefault();
              if ((value?.trim() === "" || !value) && !allowEmptyMessage) {
                toaster.create({
                  title: "Empty message",
                  description: "You must add a message to continue",
                  type: "error"
                });
                return;
              }
              setIsSending(true);
              sendMessage(value!, profile_id, true)
                .then(() => {
                  setValue("");
                })
                .catch((error) => {
                  console.error("Error sending message", error);
                  toaster.create({
                    title: "Error sending message",
                    description: error instanceof Error ? error.message : "Unknown error",
                    type: "error"
                  });
                })
                .finally(() => {
                  setIsSending(false);
                });
            }
          }}
        />
        {showEmojiPicker && (
          <Picker
            data={data}
            onClickOutside={() => setShowEmojiPicker(false)}
            onEmojiSelect={(emoji: { native: string }) => {
              setValue((value ?? "") + emoji.native);
              setShowEmojiPicker(false);
            }}
          />
        )}
        <HStack justify="flex-end">
          <HStack spaceX="0" gap="0">
            {otherButtons}
            {enableAnonymousModeToggle && (
              <Text color="text.muted" fontSize="xs">
                Post {anonymousMode ? `with your pseudonym, ${public_profile?.name} ` : `as ${private_profile?.name}`}
              </Text>
            )}
            {enableAnonymousModeToggle && (
              <Tooltip content="Toggle anonymous mode">
                <Button
                  aria-label="Toggle anonymous mode"
                  onClick={toggleAnonymousMode}
                  variant={anonymousMode ? "solid" : "ghost"}
                  size="xs"
                  colorPalette={anonymousMode ? "red" : "teal"}
                  p={0}
                >
                  <FaUserSecret />
                </Button>
              </Tooltip>
            )}
            {enableFilePicker && (
              <Tooltip content="Attach a file">
                <Button
                  aria-label="Attach a file"
                  onClick={() => fileInputRef.current?.click()}
                  variant="ghost"
                  size="xs"
                  colorPalette="teal"
                  p={0}
                >
                  <FaPaperclip />
                </Button>
              </Tooltip>
            )}
            <Tooltip content="Toggle markdown preview (supports LaTeX)">
              <Button
                aria-label="Toggle markdown preview (supports LaTeX)"
                onClick={() => setShowMarkdownPreview(!showMarkdownPreview)}
                variant="ghost"
                size="xs"
                colorPalette="teal"
                p={0}
              >
                <TbMathFunction />
              </Button>
            </Tooltip>
            {enableFilePicker && (
              <input
                title="Attach a file"
                type="file"
                ref={fileInputRef}
                style={{ display: "none" }}
                onChange={attachFile}
              />
            )}
            {enableGiphyPicker && (
              <PopoverRoot open={showGiphyPicker} onOpenChange={(e) => setShowGiphyPicker(e.open)} lazyMount>
                <PopoverTrigger asChild>
                  <Button
                    aria-label="Toggle giphy picker"
                    variant="ghost"
                    size="xs"
                    colorPalette="teal"
                    p={0}
                    onClick={() => setShowGiphyPicker(!showGiphyPicker)}
                  >
                    GIF
                  </Button>
                </PopoverTrigger>
                <PopoverContent width="400px">
                  <PopoverArrow />
                  <PopoverBody>
                    <GiphyPicker
                      onGifSelect={(gif: IGif) => {
                        setShowGiphyPicker(false);
                        sendMessage(`![${gif.title}](${gif.images.original.url})`, profile_id, false);
                      }}
                    />
                  </PopoverBody>
                </PopoverContent>
              </PopoverRoot>
            )}
            {enableEmojiPicker && (
              <Tooltip content="Toggle emoji picker">
                <Button
                  aria-label="Toggle emoji picker"
                  onClick={toggleEmojiPicker}
                  variant="ghost"
                  size="xs"
                  colorPalette="teal"
                  p={0}
                >
                  <FaSmile />
                </Button>
              </Tooltip>
            )}
          </HStack>
          <Box>
            <Field.Root orientation="horizontal">
              <Field.Label fontSize="xs">{sendButtonText ? `Enter to ${sendButtonText}` : "Enter to send"}</Field.Label>
              <Checkbox checked={enterToSend} onChange={() => setEnterToSend(!enterToSend)} />
            </Field.Root>
          </Box>
          {onClose && (
            <Button aria-label="Close" onClick={onClose} variant="ghost" size="xs" ml={2}>
              {closeButtonText ?? "Close"}
            </Button>
          )}
          <Button
            loading={isSending}
            aria-label={props.sendButtonText ? props.sendButtonText : "Send message"}
            onClick={async () => {
              if ((value?.trim() === "" || !value) && !allowEmptyMessage) {
                toaster.create({
                  title: "Empty message",
                  description: "You must add a message to continue",
                  type: "error"
                });
                return;
              }
              try {
                setIsSending(true);
                await sendMessage(value!, profile_id, true);
              } catch (error) {
                console.error("Error sending message", error);
                toaster.create({
                  title: "Error sending message",
                  description: error instanceof Error ? error.message : "Unknown error",
                  type: "error"
                });
              } finally {
                setIsSending(false);
              }
              setValue("");
            }}
            variant="solid"
            colorPalette="green"
            size="xs"
            m={2}
          >
            {props.sendButtonText ? props.sendButtonText : "Send"}
          </Button>
        </HStack>
      </VStack>
    );
  }
  return (
    <VStack align="stretch" spaceY="0" p="0" gap="0" w="100%">
      <MDEditor
        value={value}
        textareaProps={{
          disabled: isSending
        }}
        onChange={(value) => {
          setValue(value);
          props.onChange?.(value);
        }}
        {...editorProps}
      />
      <HStack justify="flex-end">
        <HStack spaceX="0" gap="0">
          {otherButtons}
          {enableAnonymousModeToggle && (
            <Text color="text.muted" fontSize="xs">
              Post {anonymousMode ? `with your pseudonym, ${public_profile?.name} ` : `as ${private_profile?.name}`}
            </Text>
          )}
          {enableAnonymousModeToggle && (
            <Tooltip content="Toggle anonymous mode">
              <Button
                aria-label="Toggle anonymous mode"
                onClick={toggleAnonymousMode}
                variant={anonymousMode ? "solid" : "ghost"}
                size="xs"
                colorPalette={anonymousMode ? "red" : "teal"}
                p={0}
              >
                <FaUserSecret />
              </Button>
            </Tooltip>
          )}
          {enableFilePicker && (
            <Tooltip content="Attach a file">
              <Button
                aria-label="Attach a file"
                onClick={() => fileInputRef.current?.click()}
                variant="ghost"
                size="xs"
                colorPalette="teal"
                p={0}
              >
                <FaPaperclip />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Toggle markdown preview (supports LaTeX)">
            <Button
              aria-label="Toggle markdown preview (supports LaTeX)"
              onClick={() => setShowMarkdownPreview(!showMarkdownPreview)}
              variant="ghost"
              size="xs"
              colorPalette="teal"
              p={0}
            >
              <TbMathFunction />
            </Button>
          </Tooltip>
          {enableFilePicker && (
            <input
              title="Attach a file"
              type="file"
              ref={fileInputRef}
              style={{ display: "none" }}
              onChange={attachFile}
            />
          )}
          {enableGiphyPicker && (
            <PopoverRoot open={showGiphyPicker} onOpenChange={(e) => setShowGiphyPicker(e.open)}>
              <PopoverTrigger asChild>
                <Button
                  aria-label="Toggle giphy picker"
                  variant="ghost"
                  size="xs"
                  colorPalette="teal"
                  p={0}
                  onClick={() => setShowGiphyPicker(!showGiphyPicker)}
                >
                  GIF
                </Button>
              </PopoverTrigger>
              <PopoverContent width="400px">
                <PopoverArrow />
                <PopoverBody>
                  <GiphyPicker
                    onGifSelect={(gif: IGif) => {
                      setShowGiphyPicker(false);
                      sendMessage(`![${gif.title}](${gif.images.original.url})`, profile_id, false);
                    }}
                  />
                </PopoverBody>
              </PopoverContent>
            </PopoverRoot>
          )}
          {enableEmojiPicker && (
            <Tooltip content="Toggle emoji picker">
              <Button
                aria-label="Toggle emoji picker"
                onClick={toggleEmojiPicker}
                variant="ghost"
                size="xs"
                colorPalette="teal"
                p={0}
              >
                <FaSmile />
              </Button>
            </Tooltip>
          )}
        </HStack>
        {onClose && (
          <Button aria-label="Close" onClick={onClose} variant="ghost" size="xs" ml={2}>
            {closeButtonText ?? "Close"}
          </Button>
        )}
        <Button
          loading={isSending}
          aria-label="Send message"
          onClick={async () => {
            if ((value?.trim() === "" || !value) && !allowEmptyMessage) {
              toaster.create({
                title: "Empty message",
                description: "You must add a message to continue",
                type: "error"
              });
              return;
            }
            try {
              setIsSending(true);
              console.log("Sending message", value, profile_id);
              await sendMessage(value!, profile_id, true);
              console.log("Message sent", value, profile_id);
              setValue("");
            } catch (error) {
              console.error(error);
              toaster.create({
                title: "Error sending message",
                description: error instanceof Error ? error.message : "Unknown error",
                type: "error"
              });
            } finally {
              setIsSending(false);
            }
          }}
          variant="solid"
          colorPalette="green"
          size="xs"
          ml={2}
        >
          {props.sendButtonText ? props.sendButtonText : "Send"}
        </Button>
      </HStack>
    </VStack>
  );
}

"use client";
import Markdown from "@/components/ui/markdown";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useMentions } from "@/hooks/useMentions";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { getLanguageFromFile, isTextFile } from "@/lib/utils";
import { getCurrentCursorPosition } from "@/utils/cursorPosition";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Field, HStack, Text, Textarea, VStack } from "@chakra-ui/react";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { IGif } from "@giphy/js-types";
import MDEditor from "@uiw/react-md-editor";
import { useParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { FaPaperclip, FaSmile, FaUserSecret } from "react-icons/fa";
import { TbMathFunction } from "react-icons/tb";
import { Checkbox } from "./checkbox";
import GiphyPicker from "./giphy-picker";
import { MentionDropdown } from "./mention-dropdown";
import { toaster } from "./toaster";
import { Tooltip } from "./tooltip";

type MessageInputProps = React.ComponentProps<typeof MDEditor> & {
  defaultSingleLine?: boolean;
  sendMessage?: (message: string, profile_id: string, close?: boolean) => Promise<void>;
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
  /**
   * The folder name to use for file uploads within the course directory.
   * Files will be uploaded to: {course_id}/{uploadFolder}/{uuid}/{fileName}
   * @default "discussion"
   */
  uploadFolder?: string;
  /**
   * Maximum number of lines for code files to be pasted as content.
   * Files exceeding this limit will be uploaded as attachments instead.
   * @default 300
   */
  maxCodeLines?: number;
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
    onChange: editorOnChange,
    value: initialValue,
    ariaLabel,
    uploadFolder = "discussion",
    maxCodeLines = 300,
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
  const [cursorPosition, setCursorPosition] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mdEditorRef = useRef<{ codemirror?: { focus(): void } }>(null);
  const internalTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Callback ref to handle both internal and external refs
  const setTextAreaRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      internalTextAreaRef.current = element;
      if (textAreaRef && "current" in textAreaRef) {
        (textAreaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = element;
      }
    },
    [textAreaRef]
  );

  const onChange = useCallback(
    (value: string) => {
      setValue(value);
      editorOnChange?.(value);
    },
    [editorOnChange]
  );
  const { public_profile_id, private_profile_id } = useClassProfiles();
  const public_profile = useUserProfile(public_profile_id);
  const private_profile = useUserProfile(private_profile_id);
  const profile_id = anonymousMode ? public_profile_id! : private_profile_id!;

  // Mention functionality - declare early so callbacks can use it
  const { mentionState, selectNext, selectPrevious, selectThread, dismissMentions } = useMentions(
    value || "",
    cursorPosition
  );

  const toggleEmojiPicker = () => setShowEmojiPicker(!showEmojiPicker);
  const toggleAnonymousMode = () => setAnonymousMode(!anonymousMode);

  const updateCursorPosition = useCallback((element: HTMLTextAreaElement) => {
    const position = getCurrentCursorPosition(element);
    setCursorPosition(position);
  }, []);

  const handleMentionSelect = useCallback(
    (index?: number) => {
      const result = selectThread(index);

      if (result) {
        const { replacement } = result;
        setValue((oldValue) => {
          if (!oldValue) return "";
          const replacementText = `[${replacement.text}](${replacement.link}) `;
          const newValue = oldValue.slice(0, replacement.start) + replacementText + oldValue.slice(replacement.end);
          editorOnChange?.(newValue);

          // Set cursor position after the replacement
          const newCursorPos = replacement.start + replacementText.length;

          if (singleLine && internalTextAreaRef.current) {
            // For textarea mode
            internalTextAreaRef.current.setSelectionRange(newCursorPos, newCursorPos);
            internalTextAreaRef.current.focus();
            setCursorPosition(newCursorPos);
          } else if (!singleLine) {
            // For MDEditor mode - find the textarea inside the editor
            const editorTextarea = containerRef.current?.querySelector("textarea");
            if (editorTextarea) {
              editorTextarea.setSelectionRange(newCursorPos, newCursorPos);
              editorTextarea.focus();
              setCursorPosition(newCursorPos);
            } else {
              if (mdEditorRef.current?.codemirror) {
                // Fallback: just focus the editor
                mdEditorRef.current.codemirror.focus();
              }
              setCursorPosition(newCursorPos);
            }
          }
          return newValue;
        });
      }
      dismissMentions();
    },
    [selectThread, dismissMentions, singleLine, editorOnChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mentionState.isActive) {
        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            selectNext();
            break;
          case "ArrowUp":
            e.preventDefault();
            selectPrevious();
            break;
          case "Enter":
          case "Tab":
            e.preventDefault();
            handleMentionSelect();
            break;
          case "Escape":
            e.preventDefault();
            dismissMentions();
            break;
        }
      }
    },
    [mentionState.isActive, selectNext, selectPrevious, handleMentionSelect, dismissMentions]
  );

  // Helper function to insert markdown at cursor position
  const insertMarkdownAtCursor = useCallback(
    (insertString: string) => {
      if (singleLine && internalTextAreaRef.current) {
        // For textarea mode
        const textarea = internalTextAreaRef.current;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const currentValue = value || "";
        const newValue = currentValue.slice(0, start) + insertString + currentValue.slice(end);
        onChange(newValue);
        // Set cursor position after insertion
        setTimeout(() => {
          if (internalTextAreaRef.current) {
            const newCursorPos = start + insertString.length;
            internalTextAreaRef.current.setSelectionRange(newCursorPos, newCursorPos);
            internalTextAreaRef.current.focus();
            setCursorPosition(newCursorPos);
          }
        }, 0);
      } else {
        // For MDEditor mode
        const textarea = containerRef.current?.querySelector("textarea");
        if (textarea) {
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const currentValue = value || "";
          const newValue = currentValue.slice(0, start) + insertString + currentValue.slice(end);
          onChange(newValue);
          // Set cursor position after insertion
          setTimeout(() => {
            const editorTextarea = containerRef.current?.querySelector("textarea");
            if (editorTextarea) {
              const newCursorPos = start + insertString.length;
              editorTextarea.setSelectionRange(newCursorPos, newCursorPos);
              editorTextarea.focus();
              setCursorPosition(newCursorPos);
            }
          }, 0);
        } else {
          // Fallback: append to end
          const currentValue = value || "";
          onChange(currentValue + insertString);
        }
      }
    },
    [singleLine, value, onChange]
  );

  const fileUpload = useCallback(
    async (file: File) => {
      // Upload file to storage
      const supabase = createClient();
      const uuid = crypto.randomUUID();
      const fileName = file.name.replace(/[^a-zA-Z0-9-_\.]/g, "_");

      // Check if this is a text/code file
      if (isTextFile(file)) {
        try {
          const content = await file.text();
          const lineCount = content.split("\n").length;

          // If file has too many lines, upload as file instead of pasting content
          if (lineCount > maxCodeLines) {
            // Fall through to regular file upload logic below
          } else {
            // File is small enough, insert as code block
            const language = getLanguageFromFile(file.name);
            const codeBlock = `**${file.name}**\n\n\`\`\`${language}\n${content}\n\`\`\``;

            if (sendMessage) {
              // Chat mode: send as separate message
              await sendMessage(codeBlock, profile_id, false);
              return null; // No URL for text files
            } else {
              // Inline mode: insert into current value
              insertMarkdownAtCursor(codeBlock);
              return null;
            }
          }
        } catch (error) {
          toaster.error({
            title: "Error reading file",
            description: `Failed to read file content: ${error instanceof Error ? error.message : "Unknown error"}`
          });
          return null;
        }
      }

      // For non-text files, upload to storage
      const { error } = await supabase.storage
        .from("uploads")
        .upload(`${course_id}/${uploadFolder}/${uuid}/${fileName}`, file);
      if (error) {
        toaster.error({
          title: "Error uploading file: " + error.name,
          description: error.message
        });
        return null;
      }
      const urlEncodedFilename = encodeURIComponent(fileName);

      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/uploads/${course_id}/${uploadFolder}/${uuid}/${urlEncodedFilename}`;

      // Determine if it's an image for proper markdown formatting
      const isImage = file.type.startsWith("image/");
      const markdownLink = isImage ? `![${file.name}](${url})` : `[${file.name}](${url})`;

      if (sendMessage) {
        // Chat mode: send as separate message
        await sendMessage(`Attachment: ${markdownLink}`, profile_id, false);
      } else {
        // Inline mode: insert markdown into current value
        insertMarkdownAtCursor(markdownLink);
      }
      return url;
    },
    [course_id, uploadFolder, profile_id, sendMessage, maxCodeLines, insertMarkdownAtCursor]
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

      // Process each file individually since text files are handled differently
      for (const file of files) {
        await fileUpload(file);
      }
    },
    [fileUpload]
  );
  if (singleLine) {
    return (
      <VStack align="stretch" spaceY="0" p="0" gap="2" w="100%" ref={containerRef} position="relative">
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
          ref={setTextAreaRef}
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
          onSelect={(e) => updateCursorPosition(e.target as HTMLTextAreaElement)}
          onClick={(e) => updateCursorPosition(e.target as HTMLTextAreaElement)}
          variant="subtle"
          autoresize
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            updateCursorPosition(e.target as HTMLTextAreaElement);
          }}
          onKeyDown={(e) => {
            handleKeyDown(e);
            if (mentionState.isActive) {
              // Mention handling is done in handleKeyDown
              return;
            }
            if (!sendMessage) {
              return;
            }
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
                  // Return focus to the textarea after sending (with small delay to ensure DOM update)
                  setTimeout(() => internalTextAreaRef?.current?.focus(), 0);
                })
                .catch((error) => {
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
        <MentionDropdown
          threads={mentionState.filteredThreads}
          selectedIndex={mentionState.selectedIndex}
          onSelect={handleMentionSelect}
          position={{ top: 0, left: 0 }}
          visible={mentionState.isActive}
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
                        if (!sendMessage) {
                          return;
                        }
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
          {sendMessage && (
            <Button
              loading={isSending}
              aria-label={props.sendButtonText ? props.sendButtonText : "Send message"}
              onClick={async () => {
                if (!sendMessage) {
                  return;
                }
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
                  setValue("");
                  // Return focus to the textarea after sending (with small delay to ensure DOM update)
                  setTimeout(() => internalTextAreaRef?.current?.focus(), 0);
                } catch (error) {
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
              m={2}
            >
              {props.sendButtonText ? props.sendButtonText : "Send"}
            </Button>
          )}
        </HStack>
      </VStack>
    );
  }
  return (
    <VStack align="stretch" spaceY="0" p="0" gap="0" w="100%" ref={containerRef} position="relative">
      <MDEditor
        ref={mdEditorRef}
        value={value}
        draggable={true}
        onDragEnter={(e) => {
          const target = e.target as HTMLElement;
          target.style.border = "2px dashed #999";
          target.style.backgroundColor = "rgba(0, 0, 0, 0.05)";
          target.style.cursor = "move";
          e.preventDefault();
          e.stopPropagation();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDragLeave={(e) => {
          const target = e.target as HTMLElement;
          target.style.border = "none";
          target.style.backgroundColor = "transparent";
          target.style.cursor = "default";
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const target = e.target as HTMLElement;
          target.style.border = "none";
          target.style.backgroundColor = "transparent";
          target.style.cursor = "default";
          await onFileTransfer(e.dataTransfer);
        }}
        onPaste={async (event) => {
          if (event.clipboardData && event.clipboardData.files.length > 0) {
            event.preventDefault();
            await onFileTransfer(event.clipboardData);
          }
        }}
        textareaProps={{
          disabled: isSending,
          onKeyDown: handleKeyDown,
          onInput: (e) => {
            // Update cursor position on every keystroke
            const textarea = e.target as HTMLTextAreaElement;
            const position = getCurrentCursorPosition(textarea);
            setCursorPosition(position);
          },
          onSelect: (e) => {
            const textarea = e.target as HTMLTextAreaElement;
            const position = getCurrentCursorPosition(textarea);
            setCursorPosition(position);
          },
          onClick: (e) => {
            const textarea = e.target as HTMLTextAreaElement;
            const position = getCurrentCursorPosition(textarea);
            setCursorPosition(position);
          },
          onKeyUp: (e) => {
            // Also update on key up to catch cursor movements
            const textarea = e.target as HTMLTextAreaElement;
            const position = getCurrentCursorPosition(textarea);
            setCursorPosition(position);
          }
        }}
        onChange={(value) => {
          setValue(value);
          editorOnChange?.(value);
          // Update cursor position when text changes
          setTimeout(() => {
            const editorTextarea = containerRef.current?.querySelector("textarea");
            if (editorTextarea) {
              const position = getCurrentCursorPosition(editorTextarea);
              setCursorPosition(position);
            }
          }, 0);
        }}
        {...editorProps}
      />
      <MentionDropdown
        threads={mentionState.filteredThreads}
        selectedIndex={mentionState.selectedIndex}
        onSelect={handleMentionSelect}
        position={{ top: 0, left: 0 }}
        visible={mentionState.isActive}
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
          {enableGiphyPicker && sendMessage && (
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
                      if (!sendMessage) {
                        return;
                      }
                      sendMessage(`![${gif.title}](${gif.images.original.url})`, profile_id, false);
                    }}
                  />
                </PopoverBody>
              </PopoverContent>
            </PopoverRoot>
          )}
          {enableEmojiPicker && sendMessage && (
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
        {sendMessage && (
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
                await sendMessage(value!, profile_id, true);
                setValue("");
                // Return focus to the MDEditor after sending
                mdEditorRef?.current?.codemirror?.focus();
              } catch (error) {
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
        )}
      </HStack>
    </VStack>
  );
}

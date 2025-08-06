"use client";
import MDEditor from "@uiw/react-md-editor";
import { useCallback } from "react";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import "katex/dist/katex.min.css";
import type { MDEditorProps } from "@uiw/react-md-editor";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { isTextFile, getLanguageFromFile } from "@/lib/utils";
// https://github.com/uiwjs/react-md-editor/issues/83

/**
 * Extended props for MdEditor component
 */
type ExtendedMdEditorProps = MDEditorProps & {
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

const insertToTextArea = (intsertString: string) => {
  const textarea = document.querySelector("textarea");
  if (!textarea) {
    return null;
  }

  let sentence = textarea.value;
  const len = sentence.length;
  const pos = textarea.selectionStart;
  const end = textarea.selectionEnd;

  const front = sentence.slice(0, pos);
  const back = sentence.slice(pos, len);

  sentence = front + intsertString + back;

  textarea.value = sentence;
  textarea.selectionEnd = end + intsertString.length;

  return sentence;
};

const MdEditor = (props: ExtendedMdEditorProps) => {
  const { uploadFolder = "discussion", maxCodeLines = 300, onChange, ...mdEditorProps } = props;
  if (!onChange) {
    throw new Error("onChange is required");
  }
  const supabase = createClient();
  const { course_id } = useParams();

  const onImagePasted = useCallback(
    async (dataTransfer: DataTransfer) => {
      const fileUpload = async (file: File) => {
        const uuid = crypto.randomUUID();
        const fileName = file.name.replace(/[^a-zA-Z0-9-_\.]/g, "_");
        const { error } = await supabase.storage
          .from("uploads")
          .upload(`${course_id}/${uploadFolder}/${uuid}/${fileName}`, file);
        if (error) {
          throw new Error(`Failed to upload file: ${error.message}`);
        }
        const urlEncodedFilename = encodeURIComponent(fileName);
        const url = `${process.env["NEXT_PUBLIC_SUPABASE_URL"]}/storage/v1/object/public/uploads/${course_id}/${uploadFolder}/${uuid}/${urlEncodedFilename}`;
        return url;
      };

      const files: File[] = [];
      for (let index = 0; index < dataTransfer.items.length; index += 1) {
        const file = dataTransfer.files.item(index);

        if (file) {
          files.push(file);
        }
      }

      for (const file of files) {
        // Check if this is a text/code file
        if (isTextFile(file)) {
          try {
            const content = await file.text();
            const lineCount = content.split("\n").length;

            // If file has too many lines, upload as file instead of pasting content
            if (lineCount > maxCodeLines) {
              const url = await fileUpload(file);
              const insertedMarkdown = `[${file.name}](${url})`;
              const insertedContent = insertToTextArea(insertedMarkdown);
              if (insertedContent) {
                onChange(insertedContent);
              }
            } else {
              // File is small enough, paste as code block
              const language = getLanguageFromFile(file.name);
              const codeBlock = `**${file.name}**\n\n\`\`\`${language}\n${content}\n\`\`\``;

              // Insert the code block into the textarea
              const insertedContent = insertToTextArea(codeBlock);
              if (insertedContent) {
                onChange(insertedContent);
              }
            }
          } catch {
            // Fall back to regular file upload if reading fails
            const url = await fileUpload(file);
            const insertedMarkdown = `[${file.name}](${url})`;
            const insertedContent = insertToTextArea(insertedMarkdown);
            if (insertedContent) {
              onChange(insertedContent);
            }
          }
        } else {
          // Handle non-text files as before
          const url = await fileUpload(file);
          const isImage = file.type.startsWith("image/");
          const insertedMarkdown = isImage ? `[![](${url})](${url})` : `[${file.name}](${url})`;
          const insertedContent = insertToTextArea(insertedMarkdown);
          if (insertedContent) {
            onChange(insertedContent);
          }
        }
      }
    },
    [supabase, onChange, course_id, uploadFolder, maxCodeLines]
  );

  return (
    <MDEditor
      {...mdEditorProps}
      onChange={onChange}
      draggable={true}
      onPaste={async (event) => {
        await onImagePasted(event.clipboardData);
      }}
      onDrop={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const target = event.target as HTMLElement;
        target.style.border = "none";
        target.style.backgroundColor = "transparent";
        target.style.cursor = "default";
        await onImagePasted(event.dataTransfer);
      }}
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
      previewOptions={{ rehypePlugins: [rehypeKatex], remarkPlugins: [remarkMath] }}
    />
  );
};

export default MdEditor;

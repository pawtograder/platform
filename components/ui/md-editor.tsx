"use client";
import MDEditor from "@uiw/react-md-editor";
import { useCallback } from "react";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import "katex/dist/katex.min.css";
import { MDEditorProps } from "@uiw/react-md-editor";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
//https://github.com/uiwjs/react-md-editor/issues/83

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

const MdEditor = (props: MDEditorProps) => {
  const onChange = props.onChange;
  if (!onChange) {
    throw new Error("onChange is required");
  }
  const supabase = createClient();
  const { course_id } = useParams();
  const onImagePasted = useCallback(
    async (dataTransfer: DataTransfer, setMarkdown: (value: string | undefined) => void) => {
      const fileUpload = async (file: File) => {
        const uuid = crypto.randomUUID();
        const fileName = file.name.replace(/[^a-zA-Z0-9-_\.]/g, "_");
        const { error } = await supabase.storage
          .from("uploads")
          .upload(`${course_id}/discussion/${uuid}/${fileName}`, file);
        if (error) {
          console.error("Error uploading image:", error);
        }
        const urlEncodedFilename = encodeURIComponent(fileName);
        const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/uploads/${course_id}/discussion/${uuid}/${urlEncodedFilename}`;
        return url;
      };
      const files: File[] = [];
      for (let index = 0; index < dataTransfer.items.length; index += 1) {
        const file = dataTransfer.files.item(index);

        if (file) {
          files.push(file);
        }
      }

      await Promise.all(
        files.map(async (file) => {
          const url = await fileUpload(file);
          const isImage = file.type.startsWith("image/");
          const insertedMarkdown = isImage ? `[![](${url})](${url})` : `[${file.name}](${url})`;
          if (!insertToTextArea(insertedMarkdown)) {
            return;
          }
          onChange(insertedMarkdown);
        })
      );
    },
    [supabase, onChange, course_id]
  );

  return (
    <MDEditor
      {...props}
      draggable={true}
      onPaste={async (event) => {
        await onImagePasted(event.clipboardData, onChange);
      }}
      onDrop={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const target = event.target as HTMLElement;
        target.style.border = "none";
        target.style.backgroundColor = "transparent";
        target.style.cursor = "default";
        await onImagePasted(event.dataTransfer, onChange);
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

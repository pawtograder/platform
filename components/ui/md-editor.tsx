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
  const { uploadFolder = "discussion", onChange, ...mdEditorProps } = props;
  if (!onChange) {
    throw new Error("onChange is required");
  }
  const supabase = createClient();
  const { course_id } = useParams();

  /**
   * Helper function to detect if a file is a text/code file
   */
  const isTextFile = useCallback((file: File): boolean => {
    // Check MIME type first
    if (file.type.startsWith("text/")) {
      return true;
    }

    // Common code file extensions that might not have proper MIME types
    const textExtensions = [
      // Programming languages
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".py",
      ".java",
      ".cpp",
      ".c",
      ".h",
      ".cs",
      ".php",
      ".rb",
      ".go",
      ".rs",
      ".kt",
      ".swift",
      ".scala",
      ".clj",
      ".hs",
      ".ml",
      ".fs",
      ".elm",
      ".dart",
      ".lua",
      ".perl",
      ".pl",
      ".r",
      ".m",
      ".vb",
      ".pas",
      ".ada",
      ".asm",
      ".s",
      ".sh",
      ".bat",
      ".ps1",
      ".fish",
      ".zsh",
      ".bash",
      // Web technologies
      ".html",
      ".htm",
      ".css",
      ".scss",
      ".sass",
      ".less",
      ".xml",
      ".xhtml",
      ".svg",
      ".vue",
      ".svelte",
      // Data formats
      ".json",
      ".yaml",
      ".yml",
      ".toml",
      ".ini",
      ".cfg",
      ".conf",
      ".properties",
      ".env",
      // Documentation
      ".md",
      ".txt",
      ".rst",
      ".adoc",
      ".tex",
      ".rtf",
      // Configuration files
      ".gitignore",
      ".gitattributes",
      ".editorconfig",
      ".prettierrc",
      ".eslintrc",
      ".babelrc",
      ".tsconfig",
      ".jsconfig",
      ".dockerfile",
      ".dockerignore",
      ".makefile",
      ".cmake",
      ".gradle",
      ".maven",
      ".ant",
      // Database
      ".sql",
      ".mongodb",
      ".cql",
      ".cypher",
      // Other
      ".log",
      ".diff",
      ".patch",
      ".lock"
    ];

    const extension = "." + file.name.split(".").pop()?.toLowerCase();
    return textExtensions.includes(extension);
  }, []);

  /**
   * Helper function to get language identifier for syntax highlighting
   */
  const getLanguageFromFile = useCallback((fileName: string): string => {
    const extension = fileName.split(".").pop()?.toLowerCase();

    const languageMap: Record<string, string> = {
      // JavaScript/TypeScript family
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      // Web technologies
      html: "html",
      htm: "html",
      css: "css",
      scss: "scss",
      sass: "sass",
      less: "less",
      xml: "xml",
      svg: "xml",
      vue: "vue",
      svelte: "svelte",
      // Programming languages
      py: "python",
      java: "java",
      cpp: "cpp",
      c: "c",
      h: "c",
      cs: "csharp",
      php: "php",
      rb: "ruby",
      go: "go",
      rs: "rust",
      kt: "kotlin",
      swift: "swift",
      scala: "scala",
      clj: "clojure",
      hs: "haskell",
      ml: "ocaml",
      fs: "fsharp",
      elm: "elm",
      dart: "dart",
      lua: "lua",
      perl: "perl",
      pl: "perl",
      r: "r",
      m: "matlab",
      vb: "vbnet",
      pas: "pascal",
      ada: "ada",
      asm: "assembly",
      s: "assembly",
      // Shell scripts
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      fish: "bash",
      bat: "batch",
      ps1: "powershell",
      // Data formats
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      toml: "toml",
      ini: "ini",
      cfg: "ini",
      conf: "ini",
      properties: "properties",
      env: "bash",
      // Documentation
      md: "markdown",
      rst: "rst",
      tex: "latex",
      // Database
      sql: "sql",
      mongodb: "javascript",
      cql: "sql",
      cypher: "cypher",
      // Configuration
      dockerfile: "dockerfile",
      makefile: "makefile",
      cmake: "cmake",
      gradle: "gradle",
      // Other
      diff: "diff",
      patch: "diff",
      log: "text",
      txt: "text"
    };

    return languageMap[extension || ""] || "text";
  }, []);

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
        const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/uploads/${course_id}/${uploadFolder}/${uuid}/${urlEncodedFilename}`;
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
            const language = getLanguageFromFile(file.name);
            const codeBlock = `**${file.name}**\n\n\`\`\`${language}\n${content}\n\`\`\``;

            // Insert the code block into the textarea
            const insertedContent = insertToTextArea(codeBlock);
            if (insertedContent) {
              onChange(insertedContent);
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
    [supabase, onChange, course_id, uploadFolder, isTextFile, getLanguageFromFile]
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

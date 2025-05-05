import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGemoji from "remark-gemoji";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

export type MarkdownProps = Parameters<typeof ReactMarkdown>[0] & { style?: React.CSSProperties };
export default function Markdown(props: MarkdownProps) {
  return (
    <div style={props.style}>
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm, remarkBreaks, remarkGemoji, ...(props.remarkPlugins || [])]}
        rehypePlugins={[rehypeKatex, rehypeHighlight, ...(props.rehypePlugins || [])]}
        {...props}
      />
    </div>
  );
}

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGemoji from "remark-gemoji";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export type MarkdownProps = Parameters<typeof ReactMarkdown>[0] & { style?: React.CSSProperties };

// Additional CSS to ensure proper list styling
const additionalStyles = `
  .wmde-markdown ul {
    list-style-type: disc !important;
  }
  .wmde-markdown ol {
    list-style-type: decimal !important;
  }
  .wmde-markdown li {
    display: list-item !important;
  }
  .wmde-markdown {
    background: transparent !important;
  }
  .wmde-markdown * {
    background: transparent !important;
  }
  .wmde-markdown p {
    background: transparent !important;
  }
  .wmde-markdown div {
    background: transparent !important;
  }
  .wmde-markdown blockquote {
    background: transparent !important;
  }
  .wmde-markdown pre {
    background: transparent !important;
  }
  .wmde-markdown code {
    background: transparent !important;
  }
`;

export default function Markdown(props: MarkdownProps) {
  return (
    <>
      <style>{additionalStyles}</style>
      <div style={props.style} className="wmde-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkMath, remarkGfm, remarkBreaks, remarkGemoji, ...(props.remarkPlugins || [])]}
          rehypePlugins={[rehypeKatex, rehypeHighlight, ...(props.rehypePlugins || [])]}
          {...props}
        />
      </div>
    </>
  );
}

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
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
    color: inherit !important;
  }
  .wmde-markdown * {
    background: transparent !important;
  }
  .wmde-markdown p {
    background: transparent !important;
    color: inherit !important;
  }
  .wmde-markdown div {
    background: transparent !important;
    color: inherit !important;
  }
  .wmde-markdown blockquote {
    background: transparent !important;
    color: inherit !important;
  }
  .wmde-markdown pre {
    background: transparent !important;
    color: inherit !important;
  }
  .wmde-markdown code {
    background: transparent !important;
    color: inherit !important;
  }
  .wmde-markdown h1,
  .wmde-markdown h2,
  .wmde-markdown h3,
  .wmde-markdown h4,
  .wmde-markdown h5,
  .wmde-markdown h6 {
    color: inherit !important;
  }
  .wmde-markdown strong,
  .wmde-markdown b {
    color: inherit !important;
  }
  .wmde-markdown em,
  .wmde-markdown i {
    color: inherit !important;
  }
  .wmde-markdown a {
    color: inherit !important;
    text-decoration: underline !important;
  }
`;

export default function Markdown(props: MarkdownProps) {
  const { style, remarkPlugins, rehypePlugins, ...rest } = props;

  const combinedRemark = [remarkMath, remarkGfm, remarkBreaks, remarkGemoji, ...(remarkPlugins || [])];
  const combinedRehype = [rehypeSanitize, rehypeKatex, rehypeHighlight, ...(rehypePlugins || [])];

  return (
    <>
      <style>{additionalStyles}</style>
      <div style={style} className="wmde-markdown">
        <ReactMarkdown {...rest} remarkPlugins={combinedRemark} rehypePlugins={combinedRehype} />
      </div>
    </>
  );
}

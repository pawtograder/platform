import remarkEscapeHtml from "@/lib/remark-escape-html";
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGemoji from "remark-gemoji";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export type MarkdownProps = Parameters<typeof ReactMarkdown>[0] & { style?: React.CSSProperties };

/**
 * Module-stable base plugin arrays.
 *
 * `react-markdown@9` keys its memoized internal `unified()` processor on
 * the *identity* of `remarkPlugins` / `rehypePlugins`. If we re-create
 * those arrays on every render — as the previous version of this file
 * did — `react-markdown` rebuilds the entire unified pipeline, which
 * means `unified.freeze()` runs anew, which (for `rehype-highlight ≥7`)
 * instantiates a fresh `Lowlight` and re-registers ~25 highlight.js
 * grammars.
 *
 * In a Chrome DevTools Performance recording during a discussion-thread
 * navigation, this single fact accounted for ~2.5 s of cumulative
 * scripting per nav: ~688 ms `registerLanguage` + ~778 ms
 * `unified.freeze` + ~1062 ms `unified.parse`, summed across one
 * `<Markdown>` per reply. Each rebuild was sliced into 1–5 ms
 * `FunctionCall`s, which is why ordinary longtask-based monitoring
 * missed it even though it dominated click-to-content wall-clock time.
 *
 * Pinning the base arrays at module scope fixes the common case (no
 * caller-supplied plugins). For the rarer case where a caller passes
 * `remarkPlugins` / `rehypePlugins`, see the `useMemo`s in `MarkdownInner`
 * — those still help if the caller-supplied arrays are themselves stable;
 * if not (e.g. a fresh `[[excerpt, { maxLength: 100 }]]` literal in
 * `DiscussionThreadList.tsx`), the caller should hoist their plugin array
 * to module scope too.
 */
const BASE_REMARK_PLUGINS: NonNullable<MarkdownProps["remarkPlugins"]> = [
  remarkEscapeHtml,
  remarkMath,
  remarkGfm,
  remarkBreaks,
  remarkGemoji
];
const BASE_REHYPE_PLUGINS_WITH_HIGHLIGHT: NonNullable<MarkdownProps["rehypePlugins"]> = [
  rehypeSanitize,
  rehypeKatex,
  rehypeHighlight
];
const BASE_REHYPE_PLUGINS_NO_HIGHLIGHT: NonNullable<MarkdownProps["rehypePlugins"]> = [rehypeSanitize, rehypeKatex];

/**
 * Cheap heuristic for "does this body contain anything that
 * `rehype-highlight` would care about?". Fenced code (```` ``` ```` /
 * ` ~~~ `) and inline `<code>` are the only triggers; everything else
 * passes through `rehype-highlight` as a no-op but still pays the cost
 * of registering grammars during processor construction.
 *
 * Most discussion replies are plain prose. Skipping the plugin for those
 * eliminates the lowlight registration entirely for the common case.
 *
 * Conservative on non-string children: keeps highlight enabled if we
 * can't introspect (shouldn't happen in practice — `react-markdown@9`
 * expects a string — but defensive in case a caller wraps).
 */
const FENCED_CODE_RE = /```|~~~|<code/;
function bodyHasCode(content: unknown): boolean {
  if (typeof content === "string") return FENCED_CODE_RE.test(content);
  return true;
}

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

function MarkdownInner(props: MarkdownProps) {
  const { style, remarkPlugins, rehypePlugins, children, ...rest } = props;

  const combinedRemark = useMemo(() => {
    if (!remarkPlugins || remarkPlugins.length === 0) return BASE_REMARK_PLUGINS;
    return [...BASE_REMARK_PLUGINS, ...remarkPlugins];
  }, [remarkPlugins]);

  // Skip `rehype-highlight` (and its ~25-language registration cost) for
  // bodies that don't contain a fenced code block. The base array picks
  // are themselves module-stable, so identity is preserved across renders
  // — keeping `react-markdown`'s internal processor cache warm.
  const includeHighlight = bodyHasCode(children);
  const combinedRehype = useMemo(() => {
    const base = includeHighlight ? BASE_REHYPE_PLUGINS_WITH_HIGHLIGHT : BASE_REHYPE_PLUGINS_NO_HIGHLIGHT;
    if (!rehypePlugins || rehypePlugins.length === 0) return base;
    return [...base, ...rehypePlugins];
  }, [rehypePlugins, includeHighlight]);

  return (
    <>
      <style>{additionalStyles}</style>
      <div style={style} className="wmde-markdown">
        <ReactMarkdown {...rest} remarkPlugins={combinedRemark} rehypePlugins={combinedRehype}>
          {children}
        </ReactMarkdown>
      </div>
    </>
  );
}

/**
 * `memo`-wrapped so a parent re-render (e.g. `replyVisible` toggling
 * inside `DiscussionThreadContent`) doesn't drag every Markdown body
 * through another React render even when its props are stable.
 */
const Markdown = memo(MarkdownInner);
Markdown.displayName = "Markdown";
export default Markdown;

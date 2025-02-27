import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGemoji from 'remark-gemoji';
import remarkMentions from 'remark-mentions';
import rehypeMermaid from 'rehype-mermaid';
import { Container } from '@chakra-ui/react';
import { createStarryNight } from '@wooorm/starry-night';

export default function Markdown(props: Parameters<typeof ReactMarkdown>[0]) {
    return <Container>
        <ReactMarkdown
            remarkPlugins={[remarkMath, remarkGfm, remarkBreaks, remarkGemoji, ...(props.remarkPlugins || [])]}
            rehypePlugins={[rehypeKatex, rehypeHighlight, ...(props.rehypePlugins || [])]}
            components={{
                span: ({ node, className, ...props }) => {
                    if (className === 'katex-html') {
                        return <span style={{ display: 'none' }} {...props} />
                    }
                    return <span className={className} {...props} />
                }
            }}
            {...props}
        />
    </Container>
}
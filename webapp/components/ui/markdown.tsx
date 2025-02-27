import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import torchlight from 'remark-torchlight';
import rehypeKatex from 'rehype-katex';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGemoji from 'remark-gemoji';
import remarkMentions from 'remark-mentions';
import rehypeMermaid from 'rehype-mermaid';
import { Container } from '@chakra-ui/react';
export default function Markdown(props: Parameters<typeof ReactMarkdown>[0]) {
    return <Container>
        <ReactMarkdown
            remarkPlugins={[remarkMath, remarkGfm, remarkBreaks, remarkGemoji]}
            rehypePlugins={[rehypeKatex]}
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
import { Container } from '@chakra-ui/react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGemoji from 'remark-gemoji';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

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
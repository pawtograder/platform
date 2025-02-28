import { createContext, useContext, useEffect, useState, SetStateAction, Dispatch } from 'react';
import { createStarryNight, common } from '@wooorm/starry-night';
import { toJsxRuntime, Components } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { Skeleton } from './skeleton';
import '@wooorm/starry-night/style/both';
import { ElementContent, Element, RootContent, Root } from 'hast'
import { Box, chakra, HStack } from '@chakra-ui/react';
import { SubmissionWithFilesAndComments, SubmissionFileWithComments } from '@/utils/supabase/DatabaseTypes';
import PersonName from './person-name';
import { Text } from '@chakra-ui/react';
import LineCommentForm from './line-comments-form';
import Markdown from './markdown';
import { format } from 'date-fns';
type CodeLineCommentContextType = {
    submission: SubmissionWithFilesAndComments;
    file: SubmissionFileWithComments;
    expanded: number[];
    close: (line: number) => void;
}
const CodeLineCommentContext = createContext<CodeLineCommentContextType | undefined>(undefined);
function useCodeLineCommentContext() {
    const context = useContext(CodeLineCommentContext);
    if (!context) {
        throw new Error('useCodeLineCommentContext must be used within a CodeLineCommentContext');
    }
    return context;
}

export default function CodeFile({
    file,
    submission
}: {
    file: SubmissionFileWithComments;
    submission: SubmissionWithFilesAndComments;
}) {
    const [starryNight, setStarryNight] = useState<Awaited<ReturnType<typeof createStarryNight>> | undefined>(undefined);
    const [expanded, setExpanded] = useState<number[]>([]);
    useEffect(() => {
        async function highlight() {
            const highlighter = await createStarryNight(common);
            setStarryNight(highlighter);
        }
        highlight();
    }, []);
    if (!starryNight || !file) {
        return <Skeleton />
    }
    const tree = starryNight.highlight(file.contents, 'source.java');
    starryNightGutter(tree, setExpanded)
    const reactNode = toJsxRuntime(tree, {
        Fragment,
        jsx,
        jsxs,
        components: {
            // @ts-ignore
            'CodeLineComment': CodeLineComment,
        }
    });
    return <Box border="1px solid" borderColor="border.emphasized" p={0}
        css={{
            "& .source-code-line": {
                cursor: "pointer",
                "&:hover": {
                    bg: "bg.emphasized",
                    width: "100%",
                }
            },
            "& .line-number": {
                width: "40px",
                textAlign: "right",
                padding: "0 5px",
                marginRight: "10px",
                borderRight: "1px solid #ccc",
                display: "inline-block",
            }
        }}
    >
        <CodeLineCommentContext.Provider value={{
            submission,
            file,
            expanded,
            close: (line: number) => {
                setExpanded((prev) =>
                    prev.filter((l) => l !== line))
            }
        }}><pre>{reactNode}</pre></CodeLineCommentContext.Provider></Box >
}

/**
 * @param {Root} tree
 *   Tree.
 * @returns {undefined}
 *   Nothing.
 */
export function starryNightGutter(tree: Root, setExpanded: Dispatch<SetStateAction<number[]>>) {
    /** @type {Array<RootContent>} */
    const replacement = []
    const search = /\r?\n|\r/g
    let index = -1
    let start = 0
    let startTextRemainder = ''
    let lineNumber = 0

    while (++index < tree.children.length) {
        const child = tree.children[index]

        if (child.type === 'text') {
            let textStart = 0
            let match = search.exec(child.value)

            while (match) {
                // Nodes in this line.
                const line = /** @type {Array<ElementContent>} */ (
                    tree.children.slice(start, index)
                )

                // Prepend text from a partial matched earlier text.
                if (startTextRemainder) {
                    line.unshift({ type: 'text', value: startTextRemainder })
                    startTextRemainder = ''
                }

                // Append text from this text.
                if (match.index > textStart) {
                    line.push({
                        type: 'text',
                        value: child.value.slice(textStart, match.index)
                    })
                }

                // Add a line, and the eol.
                lineNumber += 1
                // @ts-ignore
                replacement.push(createLine(line, lineNumber, setExpanded), {
                    type: 'text',
                    value: match[0]
                })

                start = index + 1
                textStart = match.index + match[0].length
                match = search.exec(child.value)
            }

            // If we matched, make sure to not drop the text after the last line ending.
            if (start === index + 1) {
                startTextRemainder = child.value.slice(textStart)
            }
        }
    }

    const line = /** @type {Array<ElementContent>} */ (tree.children.slice(start))
    // Prepend text from a partial matched earlier text.
    if (startTextRemainder) {
        line.unshift({ type: 'text', value: startTextRemainder })
        startTextRemainder = ''
    }

    if (line.length > 0) {
        lineNumber += 1
        // @ts-ignore
        replacement.push(createLine(line, lineNumber, setExpanded))
    }

    // Replace children with new array.
    // @ts-ignore
    tree.children = replacement
}

function CodeLineComment({ lineNumber }: { lineNumber: number }) {
    const { submission, file, expanded, close } = useCodeLineCommentContext();
    if (!submission || !file) {
        return null;
    }
    const comments = file.submission_file_comments?.filter((comment) => comment.line === lineNumber);
    const hasComments = comments && comments.length > 0;
    if (!expanded.includes(lineNumber) && !hasComments) {
        return <></>;
    }
    return <Box
        width="100%"
        position="relative" m={0} borderTop="1px solid"
        borderBottom="1px solid"
        borderColor="border.emphasized">
        <Box position="absolute" left={0}
            w="40px" h="100%"
            borderRight="1px solid #ccc"></Box>
        <Box
            position="relative"
            maxW="xl"
            fontFamily={"sans-serif"}

            m={2}
            borderWidth="1px"
            borderColor="border.emphasized"
            borderRadius="md"
            p={4}
            backgroundColor="bg"
            boxShadow="sm"
        >
            {file.submission_file_comments?.filter((comment) => comment.line === lineNumber).map((comment) => (
                <Box key={comment.id} m={0} p={2}>
                    <HStack spaceX={0} mb={2}>
                        <PersonName size="xs" uid={comment.author} />
                        <Text fontSize="xs" color="text.subtle">on {format(comment.created_at, 'MMM d, yyyy')}</Text>
                    </HStack>
                    <Box pl={2}>
                        <Markdown>{comment.comment}</Markdown>
                    </Box>
                </Box>
            ))}
            <LineCommentForm lineNumber={lineNumber} submission={submission} file={file} />
        </Box>
    </Box>
}
/**
 * @param {Array<ElementContent>} children
 * @param {number} line
 * @returns {Element}
 */
function createLine(children: ElementContent[], line: number, setExpanded: Dispatch<SetStateAction<number[]>>) {
    return {
        type: 'element',
        tagName: 'span',
        properties: {
            className: 'source-code-line-container',
        },
        children: [
            {
                type: 'element',
                tagName: 'span',
                properties: { className: 'source-code-line',
                    onClick: () => {
                        setExpanded((prev) => {
                            if (prev.includes(line)) {
                                return prev.filter((l) => l !== line);
                            }
                            return [...prev, line];
                        })
                    }
                },
                children: [
                    {
                        type: 'element',
                        tagName: 'div',
                        properties: { className: 'line-number' },
                        children: [{ type: 'text', value: line.toString() }]
                    },
                    ...children
                ]
            },
            {
                type: 'element',
                tagName: 'CodeLineComment',
                properties: { lineNumber: line },
                children: []
            }
        ]
    }
}
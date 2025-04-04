import { createContext, useContext, useEffect, useState, SetStateAction, Dispatch } from 'react';
import { createStarryNight, common } from '@wooorm/starry-night';
import { toJsxRuntime, Components } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { Skeleton } from './skeleton';
import '@wooorm/starry-night/style/both';
import { ElementContent, Element, RootContent, Root } from 'hast'
import { Badge, Box, Button, chakra, Flex, HStack, Icon, Tag, VStack } from '@chakra-ui/react';
import { SubmissionWithFilesAndComments, SubmissionFileWithComments, SubmissionFileComment, SubmissionWithFiles } from '@/utils/supabase/DatabaseTypes';
import PersonName from './person-name';
import { Text } from '@chakra-ui/react';
import LineCommentForm from './line-comments-form';
import Markdown from './markdown';
import { format } from 'date-fns';
import { useList } from '@refinedev/core';
import { Tooltip } from '@/components/ui/tooltip';
import { FaComments, FaRegComment } from 'react-icons/fa';
import PersonAvatar from './person-avatar';
import { useUserProfile } from '@/hooks/useUserProfiles';
type CodeLineCommentContextType = {
    submission: SubmissionWithFilesAndComments;
    comments: SubmissionFileComment[];
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
    const { data: comments } = useList<SubmissionFileComment>({
        resource: "submission_file_comments",
        liveMode: "auto",
        filters: [
            { field: "submission_files_id", operator: "eq", value: file.id }
        ],
        sorters: [
            { field: "created_at", order: "asc" }
        ]
    });

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
            'CodeLineComments': CodeLineComments,
            // @ts-ignore
            'LineNumber': LineNumber,
        }
    });
    return <Box border="1px solid" borderColor="border.emphasized" p={0}
        m={2}
        w="2xl"
        css={{
            "& .source-code-line": {
                cursor: "pointer",
                "&:hover": {
                    bg: "yellow.subtle",
                    width: "100%",
                    cursor: "cell",
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
        <Flex w="100%" bg="bg.subtle" p={2} borderBottom="1px solid" borderColor="border.emphasized" alignItems="center" justifyContent="space-between">
            <Text fontSize="xs" color="text.subtle">{file.name}</Text>
            <HStack>
                <Text fontSize="xs" color="text.subtle">{comments?.data?.length} {comments?.data?.length === 1 ? "comment" : "comments"}</Text>
                {comments?.data?.length && <Tooltip openDelay={300} closeDelay={100} content={expanded.length > 0 ? "Hide all comments" : "Expand all comments"}><Button variant={expanded.length > 0 ? "solid" : "outline"} size="xs" p={0} colorScheme="teal"
                    onClick={() => {
                        setExpanded((prev) => {
                            if (prev.length === 0) {
                                return comments?.data?.map((comment) => comment.line);
                            }
                            return [];
                        })
                    }}
                ><Icon as={FaComments} m={0} /></Button></Tooltip>}
            </HStack>
        </Flex>
        <CodeLineCommentContext.Provider value={{
            submission,
            comments: comments?.data || [],
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
function CodeLineComment({ comment, submission }: { comment: SubmissionFileComment, submission: SubmissionWithFilesAndComments }) {
    const authorProfile = useUserProfile(comment.author);
    const isAuthor = submission.profile_id === comment.author || submission?.assignment_groups?.assignment_groups_members?.some((member) => member.profile_id === comment.author);
    return <Box key={comment.id} m={0} p={2} w="100%">
        <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
            <PersonAvatar size="2xs" uid={comment.author} />
            <VStack alignItems="flex-start" spaceY={0} gap={1} w="100%">
                <HStack w="100%" justifyContent="space-between">
                    <HStack gap={1}>
                        <Text>{authorProfile?.name}</Text>
                        <Text fontSize="sm" color="fg.muted">on {format(comment.created_at, 'MMM d, yyyy')}</Text>
                    </HStack>
                    {isAuthor || authorProfile?.flair ? <Tag.Root size="md" colorScheme={isAuthor ? "green" : "gray"} variant="surface">
                        <Tag.Label>{isAuthor ? "Author" : authorProfile?.flair}</Tag.Label>
                    </Tag.Root> : <></>}
                </HStack>
                <Markdown>{comment.comment}</Markdown>
            </VStack>
        </HStack>
    </Box>
}
function CodeLineComments({ lineNumber }: { lineNumber: number }) {
    const { submission, comments: allCommentsForFile, file, expanded, close } = useCodeLineCommentContext();
    const comments = allCommentsForFile.filter((comment) => comment.line === lineNumber);
    const [showReply, setShowReply] = useState(comments.length === 0);
    if (!submission || !file) {
        return null;
    }
    if (!expanded.includes(lineNumber)) {
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
            p={2}
            backgroundColor="bg"
            boxShadow="sm"
        >
            {comments.map((comment) => (
                <CodeLineComment key={comment.id} comment={comment} submission={submission} />
            ))}
            {showReply ? <LineCommentForm lineNumber={lineNumber} submission={submission} file={file} /> : <Box display="flex" justifyContent="flex-end"><Button colorPalette="green" onClick={() => setShowReply(true)}>Reply</Button></Box>}
        </Box>
    </Box>
}

function LineNumber({ lineNumber }: { lineNumber: number }) {
    const { comments } = useCodeLineCommentContext();
    const hasComments = comments && comments.find((comment) => comment.line === lineNumber);
    if (hasComments) {
        return <Box className="line-number" position="relative">{lineNumber}
            <Badge variant="solid" colorPalette="blue" position="absolute" left={-5} top={0}><Icon as={FaRegComment} /></Badge>
        </Box>
    }
    return <div className="line-number">{lineNumber}</div>
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
                properties: {
                    className: 'source-code-line',
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
                        tagName: 'LineNumber',
                        properties: { lineNumber: line },
                        children: []
                    },
                    ...children
                ]
            },
            {
                type: 'element',
                tagName: 'CodeLineComments',
                properties: { lineNumber: line },
                children: []
            }
        ]
    }
}
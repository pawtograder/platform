import { Tooltip } from '@/components/ui/tooltip';
import { useIsGraderOrInstructor } from '@/hooks/useClassProfiles';
import { useRubricCheck, useSubmission, useSubmissionFile, useSubmissionFileComments, useSubmissionReview } from '@/hooks/useSubmission';
import { useUserProfile } from '@/hooks/useUserProfiles';
import { HydratedRubricCriteria, HydratedRubricCheck, RubricChecks, RubricCriteria, SubmissionFile, SubmissionFileComment, SubmissionWithFilesGraderResultsOutputTestsAndRubric } from '@/utils/supabase/DatabaseTypes';
import { Badge, Box, Button, Flex, HStack, Icon, Separator, Tag, Text, VStack } from '@chakra-ui/react';
import { useCreate, useUpdate } from '@refinedev/core';
import { common, createStarryNight } from '@wooorm/starry-night';
import '@wooorm/starry-night/style/both';
import { chakraComponents, Select, SelectComponentsConfig, SelectInstance } from 'chakra-react-select';
import { format } from 'date-fns';
import { Element, ElementContent, Root, RootContent } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { createContext, Dispatch, SetStateAction, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FaCheckCircle, FaComments, FaEyeSlash, FaRegComment, FaTimesCircle } from 'react-icons/fa';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import LineCommentForm from './line-comments-form';
import Markdown from './markdown';
import MessageInput from './message-input';
import PersonAvatar from './person-avatar';
import { RubricMarkingMenu } from './rubric-marking-menu';
import { Skeleton } from './skeleton';
import { CommentActions } from './rubric-sidebar';
type CodeLineCommentContextType = {
    submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
    comments: SubmissionFileComment[];
    file: SubmissionFile;
    expanded: number[];
    close: (line: number) => void;
    open: (line: number) => void;
    showCommentsFeature: boolean;
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
}: {
    file: SubmissionFile;
}) {
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const submission = useSubmission();
    const showCommentsFeature = submission.released !== null || isGraderOrInstructor;

    const [starryNight, setStarryNight] = useState<Awaited<ReturnType<typeof createStarryNight>> | undefined>(undefined);
    const [lineActionPopup, setLineActionPopup] = useState<LineActionPopupProps>({
        lineNumber: 0,
        top: 0,
        left: 0,
        visible: false,
        mode: "select",
        close: () => { }
    });

    const [expanded, setExpanded] = useState<number[]>([]);
    const _comments = useSubmissionFileComments({
        file_id: file.id,
        onEnter: (comments) => {
            if (showCommentsFeature) {
                setExpanded(
                    (expanded) => {
                        const newExpanded = comments.map((comment) => comment.line)
                            .filter((line) => !expanded.includes(line));
                        return [...expanded, ...newExpanded];
                    }
                );
            }
        }, onJumpTo: (comment) => {
            setExpanded((prev) => {
                if (prev.includes(comment.line)) {
                    return prev;
                }
                return [...prev, comment.line];
            })
        }
    });
    const comments = useMemo(() => {
        return _comments.sort((a, b) => {
            const createdSort = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
            if (createdSort !== 0) {
                return createdSort;
            }
            return a.line - b.line;
        });
    }, [_comments]);
    useEffect(() => {
        if (comments.length === 0) {
            setExpanded([]);
        } else {
            if (comments[0].submission_file_id === file.id) {
                setExpanded(comments.map((comment) => comment.line));
            } else {
                setExpanded([]);
            }
        }
    }, [file, comments]);

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
    starryNightGutter(tree, setExpanded, setLineActionPopup)
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
    const commentsCSS = showCommentsFeature ?
        {
            "& .source-code-line": {
                cursor: "pointer",
                display: "flex",
                flexDirection: "row",
                "&:hover": {
                    bg: "yellow.subtle",
                    width: "100%",
                    cursor: "cell",
                },
            },
            "& .selected": {
                bg: "yellow.subtle",
            }
        } : {
            "& .source-code-line": {
                display: "flex",
                flexDirection: "row",
            },
        };
    return <Box border="1px solid" borderColor="border.emphasized" p={0}
        m={2}
        minW="4xl"
        w="100%"
        css={{
            ...commentsCSS,
            "& .line-number": {
                width: "40px",
                textAlign: "right",
                padding: "0 5px",
                marginRight: "10px",
                borderRight: "1px solid #ccc",
            },
            "& .source-code-line-container": {
                width: "100%",
            },
            "& .source-code-line-content": {
            },
            "& pre": {
                whiteSpace: "pre-wrap",
                wordWrap: "break-word"
            }
        }}
    >
        <Flex w="100%" bg="bg.subtle" p={2} borderBottom="1px solid" borderColor="border.emphasized" alignItems="center" justifyContent="space-between">
            <Text fontSize="xs" color="text.subtle">{file.name}</Text>
            <HStack>
                {showCommentsFeature && comments.length > 0 && (
                    <>
                        <Text fontSize="xs" color="text.subtle">{comments.length} {comments.length === 1 ? "comment" : "comments"}</Text>

                        <Tooltip openDelay={300} closeDelay={100} content={expanded.length > 0 ? "Hide all comments" : "Expand all comments"}><Button variant={expanded.length > 0 ? "solid" : "outline"} size="xs" p={0} colorScheme="teal"
                            onClick={() => {
                                setExpanded((prev) => {
                                    if (prev.length === 0) {
                                        return comments.map((comment) => comment.line);
                                    }
                                    return [];
                                })
                            }}
                        ><Icon as={FaComments} m={0} /></Button></Tooltip></>)}
            </HStack>
        </Flex>
        <LineActionPopup {...lineActionPopup} />
        <CodeLineCommentContext.Provider value={{
            submission,
            comments,
            file,
            expanded,
            open: (line: number) => {
                setExpanded((prev) => {
                    if (prev.includes(line)) {
                        return prev;
                    }
                    return [...prev, line];
                })
            },
            close: (line: number) => {
                setExpanded((prev) =>
                    prev.filter((l) => l !== line))
            },
            showCommentsFeature
        }}><VStack
            gap={0}
            onClick={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                setLineActionPopup((prev) => {
                    prev.onClose?.();
                    return {
                        ...prev,
                        visible: false,
                        onClose: undefined,
                        close: () => { }
                    }
                });
            }}>{reactNode}</VStack></CodeLineCommentContext.Provider></Box >
}

/**
 * @param {Root} tree
 *   Tree.
 * @returns {undefined}
 *   Nothing.
 */
export function starryNightGutter(tree: Root, setExpanded: Dispatch<SetStateAction<number[]>>, setLineActionPopup: Dispatch<SetStateAction<LineActionPopupProps>>) {
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
                replacement.push(createLine(line, lineNumber, setExpanded, setLineActionPopup), {
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
function LineCheckAnnotation({ comment }: { comment: SubmissionFileComment }) {
    const { rubricCheck, rubricCriteria } = useRubricCheck(comment.rubric_check_id);
    if (!rubricCheck || !rubricCriteria) {
        return <Skeleton height="100px" width="100%" />;
    }
    const gradingReview = useSubmissionReview(comment.submission_review_id);
    const reviewName = comment.submission_review_id ? gradingReview?.name : "Self-Review";

    const pointsText = rubricCriteria.is_additive ? `+${comment.points}` : `-${comment.points}`;
    const commentAuthor = useUserProfile(comment.author);
    const [isEditing, setIsEditing] = useState(false);
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const { mutateAsync: updateComment } = useUpdate({
        resource: "submission_file_comments",
    });
    return <Box m={0} p={0} w="100%" pb={1}>
        <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
            <PersonAvatar size="2xs" uid={comment.author} />
            <VStack alignItems="flex-start" spaceY={0} gap={0} w="100%" border="1px solid" borderColor="border.info" borderRadius="md" >
                <Box bg="bg.info" pl={1} pr={1} borderRadius="md">
                    <Flex w="100%" justifyContent="space-between">
                        <HStack>
                            {!comment.released && <Tooltip content="This comment is not released to the student yet"><Icon as={FaEyeSlash} /></Tooltip>}
                            <Icon as={
                                rubricCriteria.is_additive ? FaCheckCircle : FaTimesCircle} color={rubricCriteria.is_additive ? "green.500" : "red.500"} />{pointsText}
                            <Text fontSize="sm" color="fg.muted">{rubricCriteria?.name} &gt; {rubricCheck?.name}</Text>
                        </HStack>
                        <HStack gap={0}>
                            <Text fontSize="sm" fontStyle="italic" color="fg.muted">{commentAuthor?.name} ({reviewName})</Text>
                            <CommentActions comment={comment} setIsEditing={setIsEditing} />
                        </HStack>
                    </Flex>
                </Box>
                <Box pl={2}>
                    <Markdown style={{ fontSize: '0.8rem' }}>{rubricCheck.description}</Markdown>
                </Box>
                <Box pl={2}>
                    {isEditing ? <MessageInput
                        textAreaRef={messageInputRef}
                        defaultSingleLine={true}
                        value={comment.comment}
                        closeButtonText="Cancel"
                        onClose={() => {
                            setIsEditing(false);
                        }}
                        sendMessage={async (message, profile_id) => {
                            await updateComment({ id: comment.id, values: { comment: message } });
                            setIsEditing(false);
                        }} /> : <Markdown>{comment.comment}</Markdown>}
                </Box>
            </VStack>
        </HStack>
    </Box >
}
function CodeLineComment({ comment, submission }: { comment: SubmissionFileComment, submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric }) {
    const authorProfile = useUserProfile(comment.author);
    const isAuthor = submission.profile_id === comment.author || submission?.assignment_groups?.assignment_groups_members?.some((member) => member.profile_id === comment.author);
    const [isEditing, setIsEditing] = useState(false);
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const { mutateAsync: updateComment } = useUpdate({
        resource: "submission_file_comments",
    });
    return <Box key={comment.id} m={0} pb={1} w="100%">
        <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
            <PersonAvatar size="2xs" uid={comment.author} />
            <VStack alignItems="flex-start" spaceY={0} gap={1} w="100%" border="1px solid" borderColor="border.emphasized" borderRadius="md" >
                <HStack w="100%" justifyContent="space-between" bg="bg.muted" p={0} borderTopRadius="md" borderBottom="1px solid" borderColor="border.emphasized">
                    <HStack gap={1} fontSize="sm" color="fg.muted" ml={1}>
                        <Text fontWeight="bold">{authorProfile?.name}</Text>
                        <Text>commented on {format(comment.created_at, 'MMM d, yyyy')}</Text>
                    </HStack>
                    <HStack>{isAuthor || authorProfile?.flair ? <Tag.Root size="md" colorScheme={isAuthor ? "green" : "gray"} variant="surface">
                        <Tag.Label>{isAuthor ? "Author" : authorProfile?.flair}</Tag.Label>
                    </Tag.Root> : <></>}
                        <CommentActions comment={comment} setIsEditing={setIsEditing} />
                    </HStack>
                </HStack>
                <Box pl={2}>
                    {isEditing ? <MessageInput
                        textAreaRef={messageInputRef}
                        defaultSingleLine={true}
                        value={comment.comment}
                        closeButtonText="Cancel"
                        onClose={() => {
                            setIsEditing(false);
                        }}
                        sendMessage={async (message, profile_id) => {
                            await updateComment({ id: comment.id, values: { comment: message } });
                            setIsEditing(false);
                        }} /> : <Markdown>{comment.comment}</Markdown>}
                </Box>
            </VStack>
        </HStack>
    </Box>
}

export type LineActionPopupProps = {
    lineNumber: number;
    top: number;
    left: number;
    visible: boolean;
    onClose?: () => void;
    close: () => void;
    mode: "marking" | "select";
}

export type RubricCriteriaSelectGroupOption = {
    readonly label: string;
    readonly value: string;
    readonly options: readonly RubricCheckSelectOption[];
    readonly criteria?: HydratedRubricCriteria;
}
export type RubricCheckSelectOption = {
    readonly label: string;
    readonly value: string;
    readonly check?: HydratedRubricCheck;
    readonly criteria?: HydratedRubricCriteria;
    options?: RubricCheckSubOptions[];
}
export type RubricCheckSubOptions = {
    readonly label: string;
    readonly index: string;
    readonly comment: string;
    readonly points: number;
    readonly check: RubricCheckSelectOption;
}
function formatPoints(option: { check?: HydratedRubricCheck, criteria?: HydratedRubricCriteria, points: number }) {
    if (option.check && option.criteria) {
        return `Points: ${option.criteria.is_additive ? "+" : "-"}${option.check.points}`;
    }
    return ``;
}
function LineActionPopup({ lineNumber, top, left, visible, close, onClose, mode }: LineActionPopupProps) {
    const submission = useSubmission();
    const file = useSubmissionFile();
    const review = useSubmissionReview();
    const [selectedCheckOption, setSelectedCheckOption] = useState<RubricCheckSelectOption | null>(null);
    const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);
    const selectRef = useRef<SelectInstance<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption>>(null);
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const [points, setPoints] = useState<string>();
    const popupRef = useRef<HTMLDivElement>(null);
    const [currentMode, setCurrentMode] = useState<"marking" | "select">(mode);

    const { mutateAsync: createComment } = useCreate<SubmissionFileComment>({
        resource: "submission_file_comments"
    });

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
                close();
            }
        };
        if (visible) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [visible, close]);

    useEffect(() => {
        setSelectedCheckOption(null);
    }, [lineNumber]);
    useEffect(() => {
        if (selectedCheckOption) {
            if (selectedCheckOption.check) {
                setPoints(selectedCheckOption.check.points.toString());
            }
        }
        if (messageInputRef.current) {
            messageInputRef.current.focus();
        }
    }, [selectedCheckOption, messageInputRef.current]);
    useEffect(() => {
        if (selectRef.current && !selectedCheckOption) {
            selectRef.current.focus();
        }
    }, [selectRef.current, selectedCheckOption, lineNumber]);
    useEffect(() => {
        setCurrentMode(mode);
    }, [mode]);
    useEffect(() => {
        if (!visible) {
            setCurrentMode(mode);
        }
    }, [visible, mode]);
    if (!visible) {
        return null;
    }
    //Only show criteria that have annotation checks
    const criteriaWithAnnotationChecks = submission.assignments.rubrics?.rubric_criteria.filter((criteria) => criteria.rubric_checks.some((check) => check.is_annotation));
    const criteria: RubricCriteriaSelectGroupOption[] = criteriaWithAnnotationChecks?.map((criteria) => ({
        label: criteria.name,
        value: criteria.id.toString(),
        criteria: criteria as HydratedRubricCriteria,
        options: (criteria.rubric_checks.filter((check) => check.is_annotation) as HydratedRubricCheck[]).map((check) => {
            const option: RubricCheckSelectOption = {
                label: check.name,
                value: check.id.toString(),
                check,
                criteria: criteria as HydratedRubricCriteria,
                options: []
            }
            if (check.data?.options) {
                option.options = check.data.options.map((subOption, index) => ({
                    label: (criteria.is_additive ? "+" : "-") + subOption.points + " " + subOption.label,
                    comment: subOption.label,
                    index: index.toString(),
                    points: subOption.points,
                    check: option
                }));
            }
            return option;
        })
    })) as RubricCriteriaSelectGroupOption[] || [];
    criteria.push({
        label: "Leave a comment",
        value: "comment",
        options: [{
            label: "Leave a comment",
            value: "comment"
        }]
    })
    const numChecks = criteria.reduce((acc, curr) => acc + curr.options.length, 0);
    if (currentMode === "marking" && numChecks > 1) {
        return <RubricMarkingMenu top={top} left={left} criteria={criteria}
            setSelectedSubOption={setSelectedSubOption}
            setSelectedCheckOption={setSelectedCheckOption}
            setCurrentMode={setCurrentMode} />
    }
    const components: SelectComponentsConfig<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption> = {
        GroupHeading: (props) => {
            return <chakraComponents.GroupHeading {...props}>
                {props.data.criteria ? <>
                    Criteria: {props.data.label} ({props.data.criteria.total_points} points total)
                </> : <>
                    <Separator />
                </>}
            </chakraComponents.GroupHeading>
        },
        SingleValue: (props) => {
            const points = props.data.criteria && "(" + (props.data.criteria.is_additive ? "+" : "-" + props.data.check?.points?.toString()) + ")";
            return <chakraComponents.SingleValue {...props}>
                {props.data.criteria && props.data.criteria.name + " > "} {props.data.label} {props.data.check?.data?.options ? `(Select an option)` : `${points} points`}
            </chakraComponents.SingleValue>
        },
        Option: (props) => {
            const points = props.data.criteria && "(" + ((props.data.criteria.is_additive ? "+" : "-") + props.data.check?.points?.toString()) + ")";
            return <chakraComponents.Option {...props}>
                {props.data.label} {points}
            </chakraComponents.Option>
        }
    };

    return <Box zIndex={1000} top={top} left={left}
        position="fixed"
        bg="bg.subtle"
        w="lg"
        p={2} border="1px solid" borderColor="border.emphasized" borderRadius="md"
        ref={popupRef}>
        <Box width="lg">
            <Text fontSize="sm" color="fg.muted">Annotate line {lineNumber} with a check:</Text>
            <Select
                ref={selectRef}
                options={criteria}
                defaultMenuIsOpen={selectedCheckOption === null}
                escapeClearsValue={true}
                components={components}
                value={selectedCheckOption}
                onChange={(e: RubricCheckSelectOption | null) => {
                    if (e) {
                        setSelectedCheckOption(e);
                    }
                }}
            />
            {selectedCheckOption && <>
                {selectedCheckOption.check?.data?.options && <Select
                    options={selectedCheckOption.check.data.options.map((option, index) => ({
                        label: option.label,
                        comment: option.label,
                        value: index.toString(),
                        index: index.toString(),
                        points: option.points,
                        check: selectedCheckOption
                    } as RubricCheckSubOptions))}
                    value={selectedSubOption}
                    onChange={(e: RubricCheckSubOptions | null) => {
                        setSelectedSubOption(e);
                    }}
                />}
                {(!selectedSubOption && selectedCheckOption.check) && <Text fontSize="sm" color="fg.muted">{formatPoints(selectedCheckOption.check)}</Text>}
                <MessageInput
                    textAreaRef={messageInputRef}
                    enableGiphyPicker={true}
                    placeholder={
                        !selectedCheckOption.check ? "Add a comment about this line and press enter to submit..." :
                            selectedCheckOption.check.is_comment_required ? "Add a comment about this check and press enter to submit..." : "Optionally add a comment, or just press enter to submit..."
                    }
                    allowEmptyMessage={selectedCheckOption.check && !selectedCheckOption.check.is_comment_required}
                    defaultSingleLine={true} sendMessage={async (message, profile_id) => {
                        let points = selectedCheckOption.check?.points;
                        if (selectedSubOption !== null) {
                            points = selectedSubOption.points;
                        }
                        let comment = message || '';
                        if (selectedSubOption) {
                            comment = selectedSubOption.comment + "\n" + comment;
                        }
                        const values = {
                            comment,
                            line: lineNumber,
                            rubric_check_id: selectedCheckOption.check?.id,
                            class_id: file?.class_id,
                            submission_file_id: file?.id,
                            submission_id: submission.id,
                            author: profile_id,
                            released: review ? false : true,
                            points,
                            submission_review_id: review?.id
                        };
                        await createComment({ values });
                        setCurrentMode(mode);
                        close();
                    }} /></>}
        </Box>
    </Box>
}
function CodeLineComments({ lineNumber }: { lineNumber: number }) {
    const { submission, showCommentsFeature, comments: allCommentsForFile, file, expanded, close } = useCodeLineCommentContext();
    const comments = allCommentsForFile.filter((comment) => comment.line === lineNumber);
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const isReplyEnabled = isGraderOrInstructor || submission.released !== null;
    const [showReply, setShowReply] = useState(isReplyEnabled);
    if (!submission || !file || !showCommentsFeature) {
        return null;
    }
    if (!expanded.includes(lineNumber)) {
        return <></>;
    }
    return <Box
        width="100%"
        whiteSpace="normal"
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
                comment.rubric_check_id ? <LineCheckAnnotation key={comment.id} comment={comment} /> :
                    <CodeLineComment key={comment.id} comment={comment} submission={submission} />
            ))}
            {showReply ? <LineCommentForm lineNumber={lineNumber} submission={submission} file={file} /> : <Box display="flex" justifyContent="flex-end"><Button colorPalette="green" onClick={() => setShowReply(true)}>Add Comment</Button></Box>}
        </Box>
    </Box>
}

function LineNumber({ lineNumber }: { lineNumber: number }) {
    const { comments, open } = useCodeLineCommentContext();
    const hasComments = comments && comments.find((comment) => comment.line === lineNumber);
    if (hasComments) {
        return <Box className="line-number" position="relative">{lineNumber}
            <Badge
                onClick={() => {
                    open(lineNumber);
                }}
                variant="solid" colorPalette="blue" position="absolute" left={-5} top={0}><Icon as={FaRegComment} /></Badge>
        </Box>
    }
    return <div className="line-number">{lineNumber}</div>
}
/**
 * @param {Array<ElementContent>} children
 * @param {number} line
 * @returns {Element}
 */
function createLine(children: ElementContent[], line: number, setExpanded: Dispatch<SetStateAction<number[]>>, setLineActionPopup: Dispatch<SetStateAction<LineActionPopupProps>>) {
    return {
        type: 'element',
        tagName: 'div',
        properties: {
            className: 'source-code-line-container',
        },
        children: [
            {
                type: 'element',
                tagName: 'pre',
                properties: {
                    className: 'source-code-line',
                    id: `L${line}`,
                    onMouseDown: (ev: MouseEvent) => {
                        if (ev.button !== 0) {
                            return;
                        }
                        ev.preventDefault();
                        ev.stopPropagation();
                        setLineActionPopup((prev) => {
                            if (line !== prev.lineNumber) {
                                prev.onClose?.();
                            }
                            return {
                                lineNumber: line,
                                top: ev.clientY,
                                left: ev.clientX,
                                visible: true,
                                mode: "marking",
                                close: () => {
                                    setLineActionPopup({
                                        lineNumber: line,
                                        top: 0,
                                        left: 0,
                                        visible: false,
                                        onClose: undefined,
                                        close: () => { },
                                        mode: "marking"
                                    });
                                },
                            }
                        });
                    },
                    oncontextmenu: (ev: MouseEvent) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        const target = ev.currentTarget as HTMLElement;
                        target.classList.add('selected');
                        const onClose = () => {
                            target.classList.remove('selected');
                        }
                        setLineActionPopup((prev) => {
                            if (line !== prev.lineNumber) {
                                prev.onClose?.();
                            }
                            return {
                                lineNumber: line,
                                top: ev.clientY,
                                left: ev.clientX,
                                visible: true,
                                mode: "select",
                                close: () => {
                                    onClose();
                                    setLineActionPopup({
                                        lineNumber: line,
                                        top: 0,
                                        left: 0,
                                        visible: false,
                                        onClose: undefined,
                                        close: () => { },
                                        mode: "select"
                                    });
                                },
                                onClose
                            }
                        });
                    }
                },
                children: [
                    {
                        type: 'element',
                        tagName: 'LineNumber',
                        properties: { lineNumber: line },
                        children: []
                    },
                    {
                        type: 'element',
                        tagName: 'div',
                        properties: {
                            className: 'source-code-line-content',
                        },
                        children: children
                    }
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
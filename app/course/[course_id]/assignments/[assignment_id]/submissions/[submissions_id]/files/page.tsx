"use client";

import CodeFile, {
  formatPoints,
  RubricCheckSelectOption,
  RubricCheckSubOptions,
  RubricCriteriaSelectGroupOption
} from "@/components/ui/code-file";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import PersonAvatar from "@/components/ui/person-avatar";
import { PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { CommentActions } from "@/components/ui/rubric-sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import {
  useRubricCheck,
  useSubmission,
  useSubmissionArtifactComments,
  useSubmissionController,
  useSubmissionFileComments,
  useSubmissionReview
} from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { createClient } from "@/utils/supabase/client";
import {
  HydratedRubricCheck,
  HydratedRubricCriteria,
  SubmissionArtifact,
  SubmissionArtifactComment,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric
} from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  ClientOnly,
  Flex,
  Heading,
  HStack,
  Icon,
  Separator,
  Spinner,
  Table,
  Tag,
  Text,
  VStack
} from "@chakra-ui/react";
import { useCreate, useInvalidate, useUpdate } from "@refinedev/core";
import { chakraComponents, Select, SelectComponentsConfig, SelectInstance } from "chakra-react-select";
import { format } from "date-fns";
import JSZip from "jszip";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FaCheckCircle, FaEyeSlash, FaTimesCircle } from "react-icons/fa";
import zipToHTMLBlobs from "./zipToHTMLBlobs";
function FilePicker({ curFile }: { curFile: number }) {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const comments = useSubmissionFileComments({});
  const showCommentsFeature = submission.released !== null || isGraderOrInstructor;
  return (
    <Box
      maxH="250px"
      overflowY="auto"
      w="100%"
      m={2}
      css={{
        "&::-webkit-scrollbar": {
          width: "8px",
          display: "block"
        },
        "&::-webkit-scrollbar-track": {
          background: "#f1f1f1",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb": {
          background: "#888",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb:hover": {
          background: "#555"
        }
      }}
    >
      <Table.Root borderWidth="1px" borderColor="border.emphasized" w="100%" borderRadius="md">
        <Table.Header>
          <Table.Row bg="bg.subtle">
            <Table.ColumnHeader>File</Table.ColumnHeader>
            {showCommentsFeature && <Table.ColumnHeader>Comments</Table.ColumnHeader>}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {submission.submission_files.map((file, idx) => (
            <Table.Row key={file.id}>
              <Table.Cell>
                <Link
                  variant={curFile === idx ? "underline" : undefined}
                  href={`/course/${submission.assignments.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/files/?file_id=${file.id}`}
                >
                  {file.name}
                </Link>
              </Table.Cell>
              {showCommentsFeature && (
                <Table.Cell>{comments.filter((comment) => comment.submission_file_id === file.id).length}</Table.Cell>
              )}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
function ArtifactPicker({ curArtifact }: { curArtifact: number }) {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const comments = useSubmissionArtifactComments({});
  const showCommentsFeature = submission.released !== null || isGraderOrInstructor;
  if (!submission.submission_artifacts || submission.submission_artifacts.length === 0) {
    return <></>;
  }
  return (
    <Box
      maxH="250px"
      w="100%"
      m={2}
      overflowY="auto"
      css={{
        "&::-webkit-scrollbar": {
          width: "8px",
          display: "block"
        },
        "&::-webkit-scrollbar-track": {
          background: "#f1f1f1",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb": {
          background: "#888",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb:hover": {
          background: "#555"
        }
      }}
    >
      <Table.Root borderWidth="1px" borderColor="border.emphasized" w="100%" borderRadius="md">
        <Table.Header>
          <Table.Row bg="bg.subtle">
            <Table.ColumnHeader>Artifact</Table.ColumnHeader>
            {showCommentsFeature && <Table.ColumnHeader>Comments</Table.ColumnHeader>}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {submission.submission_artifacts.map((artifact, idx) => (
            <Table.Row key={artifact.id}>
              <Table.Cell>
                <Link
                  variant={curArtifact === idx ? "underline" : undefined}
                  href={`/course/${submission.assignments.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/files/?artifact_id=${artifact.id}`}
                >
                  {artifact.name}
                </Link>
              </Table.Cell>
              {showCommentsFeature && (
                <Table.Cell>
                  {comments.filter((comment) => comment.submission_artifact_id === artifact.id).length}
                </Table.Cell>
              )}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}

function ArtifactAnnotation({ comment }: { comment: SubmissionArtifactComment }) {
  const { rubricCheck, rubricCriteria } = useRubricCheck(comment.rubric_check_id);
  const commentAuthor = useUserProfile(comment.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const { mutateAsync: updateComment } = useUpdate({
    resource: "submission_artifact_comments"
  });
  const gradingReview = useSubmissionReview(comment.submission_review_id);

  if (!rubricCheck || !rubricCriteria) {
    return <Skeleton height="100px" width="100%" />;
  }
  const reviewName = comment.submission_review_id ? gradingReview?.name : "Self-Review";

  const pointsText = rubricCriteria.is_additive ? `+${comment.points}` : `-${comment.points}`;

  return (
    <Box m={0} p={0} w="100%" pb={1}>
      <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
        <PersonAvatar size="2xs" uid={comment.author} />
        <VStack
          alignItems="flex-start"
          spaceY={0}
          gap={0}
          w="100%"
          border="1px solid"
          borderColor="border.info"
          borderRadius="md"
        >
          <Box bg="bg.info" pl={1} pr={1} borderRadius="md" w="100%">
            <Flex w="100%" justifyContent="space-between">
              <HStack>
                {!comment.released && (
                  <Tooltip content="This comment is not released to the student yet">
                    <Icon as={FaEyeSlash} />
                  </Tooltip>
                )}
                <Icon
                  as={rubricCriteria.is_additive ? FaCheckCircle : FaTimesCircle}
                  color={rubricCriteria.is_additive ? "green.500" : "red.500"}
                />
                {pointsText}
                <Text fontSize="sm" color="fg.muted">
                  {rubricCriteria?.name} &gt; {rubricCheck?.name}
                </Text>
              </HStack>
              <HStack gap={0}>
                <Text fontSize="sm" fontStyle="italic" color="fg.muted">
                  {commentAuthor?.name} ({reviewName})
                </Text>
                <CommentActions comment={comment} setIsEditing={setIsEditing} />
              </HStack>
            </Flex>
          </Box>
          <Box pl={2}>
            <Markdown style={{ fontSize: "0.8rem" }}>{rubricCheck.description}</Markdown>
          </Box>
          <Box pl={2}>
            {isEditing ? (
              <MessageInput
                textAreaRef={messageInputRef}
                defaultSingleLine={true}
                value={comment.comment}
                closeButtonText="Cancel"
                onClose={() => {
                  setIsEditing(false);
                }}
                sendMessage={async (message) => {
                  await updateComment({ id: comment.id, values: { comment: message } });
                  setIsEditing(false);
                }}
              />
            ) : (
              <Markdown>{comment.comment}</Markdown>
            )}
          </Box>
        </VStack>
      </HStack>
    </Box>
  );
}
function ArtifactComment({
  comment,
  submission
}: {
  comment: SubmissionArtifactComment;
  submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
}) {
  const authorProfile = useUserProfile(comment.author);
  const isAuthor =
    submission.profile_id === comment.author ||
    submission?.assignment_groups?.assignment_groups_members?.some((member) => member.profile_id === comment.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const { mutateAsync: updateComment } = useUpdate({
    resource: "submission_artifact_comments"
  });
  return (
    <Box key={comment.id} m={0} pb={1} w="100%">
      <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
        <PersonAvatar size="2xs" uid={comment.author} />
        <VStack
          alignItems="flex-start"
          spaceY={0}
          gap={1}
          w="100%"
          border="1px solid"
          borderColor="border.emphasized"
          borderRadius="md"
        >
          <HStack
            w="100%"
            justifyContent="space-between"
            bg="bg.muted"
            p={0}
            borderTopRadius="md"
            borderBottom="1px solid"
            borderColor="border.emphasized"
          >
            <HStack gap={1} fontSize="sm" color="fg.muted" ml={1}>
              <Text fontWeight="bold">{authorProfile?.name}</Text>
              <Text>commented on {format(comment.created_at, "MMM d, yyyy")}</Text>
            </HStack>
            <HStack>
              {isAuthor || authorProfile?.flair ? (
                <Tag.Root size="md" colorPalette={isAuthor ? "green" : authorProfile?.flair_color} variant="surface">
                  <Tag.Label>{isAuthor ? "Author" : authorProfile?.flair}</Tag.Label>
                </Tag.Root>
              ) : (
                <></>
              )}
              <CommentActions comment={comment} setIsEditing={setIsEditing} />
            </HStack>
          </HStack>
          <Box pl={2}>
            {isEditing ? (
              <MessageInput
                textAreaRef={messageInputRef}
                defaultSingleLine={true}
                value={comment.comment}
                closeButtonText="Cancel"
                onClose={() => {
                  setIsEditing(false);
                }}
                sendMessage={async (message) => {
                  await updateComment({ id: comment.id, values: { comment: message } });
                  setIsEditing(false);
                }}
              />
            ) : (
              <Markdown>{comment.comment}</Markdown>
            )}
          </Box>
        </VStack>
      </HStack>
    </Box>
  );
}

function AritfactCheckEntry({
  artifact,
  setIsOpen
}: {
  artifact: SubmissionArtifact;
  setIsOpen: (isOpen: boolean) => void;
}) {
  const submission = useSubmission();
  const review = useSubmissionReview();
  const [selectedCheckOption, setSelectedCheckOption] = useState<RubricCheckSelectOption | null>(null);
  const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);
  const selectRef = useRef<SelectInstance<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption>>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const { mutateAsync: createComment } = useCreate<SubmissionArtifactComment>({
    resource: "submission_artifact_comments"
  });
  useEffect(() => {
    if (messageInputRef.current) {
      messageInputRef.current.focus();
    }
  }, [selectedCheckOption]);
  useEffect(() => {
    if (selectRef.current && !selectedCheckOption) {
      selectRef.current.focus();
    }
  }, [selectedCheckOption, artifact.id]);
  //Only show criteria that have annotation checks
  const criteriaWithAnnotationChecks = submission.assignments.rubrics?.rubric_criteria.filter((criteria) =>
    criteria.rubric_checks.some((check) => check.is_annotation && check.annotation_target === "artifact")
  );
  const criteria: RubricCriteriaSelectGroupOption[] =
    (criteriaWithAnnotationChecks?.map((criteria) => ({
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
        };
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
    })) as RubricCriteriaSelectGroupOption[]) || [];
  criteria.push({
    label: "Leave a comment",
    value: "comment",
    options: [
      {
        label: "Leave a comment",
        value: "comment"
      }
    ]
  });
  const numChecks = criteria.reduce((acc, curr) => acc + curr.options.length, 0);
  const components: SelectComponentsConfig<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption> = {
    GroupHeading: (props) => {
      return (
        <chakraComponents.GroupHeading {...props}>
          {props.data.criteria ? (
            <>
              Criteria: {props.data.label} ({props.data.criteria.total_points} points total)
            </>
          ) : (
            <>
              <Separator />
            </>
          )}
        </chakraComponents.GroupHeading>
      );
    },
    SingleValue: (props) => {
      const points =
        props.data.criteria &&
        props.data.check?.points &&
        "(" + (props.data.criteria.is_additive ? "+" : "-" + props.data.check?.points?.toString()) + ")";
      return (
        <chakraComponents.SingleValue {...props}>
          {props.data.criteria && props.data.criteria.name + " > "} {props.data.label}{" "}
          {props.data.check?.data?.options ? `(Select an option)` : points ? `${points} points` : ""}
        </chakraComponents.SingleValue>
      );
    },
    Option: (props) => {
      const points =
        props.data.criteria &&
        "(" + ((props.data.criteria.is_additive ? "+" : "-") + props.data.check?.points?.toString()) + ")";
      return (
        <chakraComponents.Option {...props}>
          {props.data.label} {points}
        </chakraComponents.Option>
      );
    }
  };
  if (numChecks === 0) {
    return (
      <Box>
        <Text fontSize="sm" color="fg.muted">
          No checks available for this artifact
        </Text>
      </Box>
    );
  }

  return (
    <Box
      bg="bg.subtle"
      w="lg"
      p={2}
      border="1px solid"
      borderColor="border.emphasized"
      borderRadius="md"
      ref={popupRef}
    >
      <Box>
        <Text fontSize="sm" color="fg.muted">
          Annotate artifact with a check:
        </Text>
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
        {selectedCheckOption && (
          <>
            {selectedCheckOption.check?.data?.options && (
              <Select
                options={selectedCheckOption.check.data.options.map(
                  (option, index) =>
                    ({
                      label: option.label,
                      comment: option.label,
                      value: index.toString(),
                      index: index.toString(),
                      points: option.points,
                      check: selectedCheckOption
                    }) as RubricCheckSubOptions
                )}
                value={selectedSubOption}
                onChange={(e: RubricCheckSubOptions | null) => {
                  setSelectedSubOption(e);
                }}
              />
            )}
            {!selectedSubOption && selectedCheckOption.check && (
              <Text fontSize="sm" color="fg.muted">
                {formatPoints(selectedCheckOption.check)}
              </Text>
            )}
            <MessageInput
              textAreaRef={messageInputRef}
              enableGiphyPicker={true}
              placeholder={
                !selectedCheckOption.check
                  ? "Add a comment about this line and press enter to submit..."
                  : selectedCheckOption.check.is_comment_required
                    ? "Add a comment about this check and press enter to submit..."
                    : "Optionally add a comment, or just press enter to submit..."
              }
              allowEmptyMessage={selectedCheckOption.check && !selectedCheckOption.check.is_comment_required}
              defaultSingleLine={true}
              sendMessage={async (message, profile_id) => {
                let points = selectedCheckOption.check?.points;
                if (selectedSubOption !== null) {
                  points = selectedSubOption.points;
                }
                let comment = message || "";
                if (selectedSubOption) {
                  comment = selectedSubOption.comment + "\n" + comment;
                }
                const values = {
                  comment,
                  rubric_check_id: selectedCheckOption.check?.id,
                  class_id: artifact.class_id,
                  submission_artifact_id: artifact.id,
                  submission_id: submission.id,
                  author: profile_id,
                  released: review ? false : true,
                  points,
                  submission_review_id: review?.id
                };
                await createComment({ values });
                setIsOpen(false);
              }}
            />
          </>
        )}
      </Box>
    </Box>
  );
}
function AritfactComments({ artifact }: { artifact: SubmissionArtifact }) {
  const comments = useSubmissionArtifactComments({}).filter(
    (comment) => comment.deleted_at === null && comment.submission_artifact_id === artifact.id
  );
  const submission = useSubmission();

  const isGraderOrInstructor = useIsGraderOrInstructor();
  const isReplyEnabled = isGraderOrInstructor || submission.released !== null;
  const [showReply, setShowReply] = useState(isReplyEnabled);
  const showCommentsFeature = submission.released !== null || isGraderOrInstructor;

  if (!submission || !artifact || !showCommentsFeature) {
    return null;
  }
  return (
    <Box
      width="100%"
      p={4}
      whiteSpace="normal"
      position="relative"
      m={0}
      borderTop="1px solid"
      borderBottom="1px solid"
      borderColor="border.emphasized"
    >
      <Box position="absolute" left={0} w="40px" h="100%" borderRight="1px solid #ccc"></Box>
      <Box
        position="relative"
        w="100%"
        fontFamily={"sans-serif"}
        m={0}
        borderWidth="1px"
        borderColor="border.emphasized"
        borderRadius="md"
        p={0}
        backgroundColor="bg"
        boxShadow="sm"
      >
        {comments.map((comment) =>
          comment.rubric_check_id ? (
            <ArtifactAnnotation key={comment.id} comment={comment} />
          ) : (
            <ArtifactComment key={comment.id} comment={comment} submission={submission} />
          )
        )}
        {showReply ? (
          <ArtifactCommentsForm
            submission={submission}
            artifact={artifact}
            defaultValue={comments.length > 0 ? "Reply" : "Add Comment"}
          />
        ) : (
          <Box display="flex" justifyContent="flex-end">
            <Button colorPalette="green" onClick={() => setShowReply(true)}>
              Add Comment
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}
function ArtifactCommentsForm({
  submission,
  artifact,
  defaultValue
}: {
  submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
  artifact: SubmissionArtifact;
  defaultValue: string;
}) {
  // const rubrics = submission.assignments.rubrics.filter((rubric) => rubric.is_annotation);
  // rubrics.sort((a, b) => a.ordinal - b.ordinal);

  const { mutateAsync: createComment } = useCreate<SubmissionArtifactComment>({
    resource: "submission_artifact_comments"
  });
  const review = useSubmissionReview();
  const invalidateQuery = useInvalidate();
  const { private_profile_id } = useClassProfiles();

  const postComment = useCallback(
    async (message: string) => {
      const values = {
        submission_id: submission.id,
        submission_artifact_id: artifact.id,
        class_id: artifact.class_id,
        author: private_profile_id!,
        comment: message,
        submission_review_id: review?.id,
        released: review ? false : true
      };
      await createComment({
        values: values
      });
      invalidateQuery({
        resource: "submission_artifacts",
        id: artifact.id,
        invalidates: ["all"]
      });
    },
    [submission, artifact, createComment, private_profile_id, invalidateQuery, review]
  );

  return (
    <MessageInput
      className="w-full p-2 border rounded"
      defaultSingleLine={true}
      sendMessage={postComment}
      sendButtonText="Save"
      defaultValue={defaultValue}
    />
  );
}
function ArtifactCheckPopover({ artifact }: { artifact: SubmissionArtifact }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <PopoverRoot
      open={isOpen}
      onOpenChange={(details) => {
        setIsOpen(details.open);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="subtle" colorPalette="green" w="100%">
          Add Check
        </Button>
      </PopoverTrigger>
      <PopoverBody>
        <PopoverContent>
          <AritfactCheckEntry artifact={artifact} setIsOpen={setIsOpen} />
        </PopoverContent>
      </PopoverBody>
    </PopoverRoot>
  );
}
function ArtifactWithComments({ artifact }: { artifact: SubmissionArtifact }) {
  return (
    <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" m={2}>
      <Box bg="bg.muted" p={2} borderBottom="1px solid" borderColor="border.emphasized">
        <HStack justifyContent="space-between">
          <Heading size="md">Artifact: {artifact.name}</Heading>
          <Button
            variant="surface"
            colorPalette="green"
            onClick={() => {
              const client = createClient();
              const artifactKey = `classes/${artifact.class_id}/profiles/${artifact.profile_id ? artifact.profile_id : artifact.assignment_group_id}/submissions/${artifact.submission_id}/${artifact.id}`;
              client.storage
                .from("submission-artifacts")
                .createSignedUrl(artifactKey, 60 * 60 * 24 * 30)
                .then((data) => {
                  //Coerce download of the signed url
                  const a = document.createElement("a");
                  a.href = data?.data?.signedUrl || "";
                  a.download = artifact.name;
                  a.click();
                });
            }}
          >
            Download
          </Button>
        </HStack>
      </Box>
      <ArtifactView artifact={artifact} />
      <ArtifactCheckPopover artifact={artifact} />
      <AritfactComments artifact={artifact} />
    </Box>
  );
}
function ArtifactView({ artifact }: { artifact: SubmissionArtifact }) {
  //Load the artifact data from supabase
  const [artifactData, setArtifactData] = useState<Blob | null>(null);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  const artifactKey = `classes/${artifact.class_id}/profiles/${artifact.profile_id ? artifact.profile_id : artifact.assignment_group_id}/submissions/${artifact.submission_id}/${artifact.id}`;
  useEffect(() => {
    let cleanup: (() => void) | undefined = undefined;
    async function loadArtifact() {
      const client = createClient();
      const data = await client.storage.from("submission-artifacts").download(artifactKey);
      if (data.data) {
        setArtifactData(data.data);
        if (artifact.data.format === "zip" && artifact.data.display === "html_site") {
          try {
            //TODO this will NEVER work in safari, we need to just unzip it on a server and serve the files
            const zip = await JSZip.loadAsync(data.data);
            const { rewrittenHTMLFiles, topLevelDir } = await zipToHTMLBlobs(data.data);
            const listener = async (event: MessageEvent) => {
              if (event.data.type === "REQUEST_FILE_CONTENTS") {
                // Create a map of file contents
                const fileContents: Record<string, string | Uint8Array> = {};
                //Find the top level directory
                // Process all files in parallel
                await Promise.all(
                  Object.entries(zip.files).map(async ([path, file]) => {
                    const pathRelativeToTopLevelDir = path.replace(topLevelDir, "");
                    if (!file.dir) {
                      // Get the content based on file type
                      if (pathRelativeToTopLevelDir.endsWith(".html")) {
                        fileContents[pathRelativeToTopLevelDir] = rewrittenHTMLFiles.get(pathRelativeToTopLevelDir)!;
                      } else if (
                        pathRelativeToTopLevelDir.endsWith(".css") ||
                        pathRelativeToTopLevelDir.endsWith(".js") ||
                        pathRelativeToTopLevelDir.endsWith(".json")
                      ) {
                        fileContents[pathRelativeToTopLevelDir] = await file.async("text");
                      } else {
                        fileContents[pathRelativeToTopLevelDir] = await file.async("uint8array");
                      }
                    }
                  })
                );
                // Send all file contents to the iframe
                event.source?.postMessage(
                  {
                    type: "FILE_CONTENTS_RESPONSE",
                    fileContents
                  },
                  { targetOrigin: "*" }
                );
              }
            };
            window.addEventListener("message", listener);
            cleanup = () => {
              window.removeEventListener("message", listener);
            };
            if (rewrittenHTMLFiles.get("/index.html")) {
              const url = URL.createObjectURL(
                new Blob([rewrittenHTMLFiles.get("/index.html")!], { type: "text/html" })
              );
              setSiteUrl(url);
            }
          } catch (error) {
            console.error("Error processing ZIP file:", error);
          }
        }
      }
      if (data.error) {
        console.error(data.error);
      }
    }
    loadArtifact();
    return () => {
      console.log("Outer cleanup");
      if (cleanup) {
        cleanup();
      }
    };
  }, [artifactKey, artifact.data?.display, artifact.data?.format]);
  if (artifact.data.format === "png") {
    if (artifactData) {
      return <Image src={URL.createObjectURL(artifactData)} alt={artifact.name} />;
    } else {
      return <Spinner />;
    }
  } else if (artifact.data.format === "zip") {
    if (artifact.data.display === "html_site") {
      if (siteUrl) {
        return (
          <Box>
            <ClientOnly>
              <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" overflow="hidden">
                <iframe
                  src={siteUrl}
                  style={{ width: "100%", height: "100%", border: "none", minHeight: "500px" }}
                  title={artifact.name}
                  sandbox="allow-scripts"
                />
              </Box>
            </ClientOnly>
          </Box>
        );
      } else {
        return <Spinner />;
      }
    }
  }
  return (
    <Box>
      <Text>{artifact.name}</Text>
    </Box>
  );
}

export default function FilesView() {
  const [curFile, setCurFile] = useState<number>(0);
  const [curArtifact, setCurArtifact] = useState<number>(0);
  const [currentView, setCurrentView] = useState<"file" | "artifact">("file");
  const searchParams = useSearchParams();
  const file_id = searchParams.get("file_id");
  const artifact_id = searchParams.get("artifact_id");
  const submission = useSubmission();
  const submissionController = useSubmissionController();
  useEffect(() => {
    if (file_id) {
      setCurrentView("file");
      setCurFile(submission.submission_files.findIndex((file) => file.id === Number.parseInt(file_id)));
    }
  }, [file_id, submission.submission_files]);
  useEffect(() => {
    if (artifact_id) {
      setCurrentView("artifact");
      setCurArtifact(
        submission.submission_artifacts.findIndex((artifact) => artifact.id === Number.parseInt(artifact_id))
      );
    }
  }, [artifact_id, submission.submission_artifacts]);
  useEffect(() => {
    submissionController.file = submission.submission_files[curFile];
  }, [curFile, submission.submission_files, submissionController]);
  useEffect(() => {
    submissionController.artifact = submission.submission_artifacts[curArtifact] as SubmissionArtifact;
  }, [curArtifact, submission.submission_artifacts, submissionController]);
  return (
    <Box pt={4} w="100%">
      <Flex w="100%">
        <Box w="100%">
          <FilePicker curFile={curFile} />
          <ArtifactPicker curArtifact={curArtifact} />
          {currentView === "file" && submission.submission_files[curFile] && (
            <CodeFile file={submission.submission_files[curFile]} />
          )}
          {currentView === "artifact" && submission.submission_artifacts[curArtifact] && (
            <ArtifactWithComments artifact={submission.submission_artifacts[curArtifact] as SubmissionArtifact} />
          )}
        </Box>
      </Flex>
    </Box>
  );
}

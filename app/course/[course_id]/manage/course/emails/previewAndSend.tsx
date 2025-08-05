import { useEmailManagement } from "./EmailManagementContext";
import { useCreate, useInvalidate } from "@refinedev/core";
import { Box, Button, Card, Editable, Flex, Heading, HStack, Spacer, Text } from "@chakra-ui/react";
import { IoMdClose } from "react-icons/io";
import { useParams } from "next/navigation";
import { SetStateAction, useMemo, useState } from "react";
import { CreatableSelect, Select } from "chakra-react-select";
import { UserRoleWithUserDetails } from "./page";
import { ToggleTip } from "@/components/ui/toggle-tip";
import { LuInfo } from "react-icons/lu";
import { toaster } from "@/components/ui/toaster";
import { Emails } from "@/utils/supabase/DatabaseTypes";

export default function EmailPreviewAndSend({ userRoles }: { userRoles?: UserRoleWithUserDetails[] }) {
  const { course_id } = useParams();
  const { emailsToCreate, clearEmails, batches } = useEmailManagement();
  const { mutateAsync } = useCreate();
  const invalidate = useInvalidate();

  const sendEmails = async () => {
    const emailsFormatted: Omit<Emails, "id" | "created_at">[] = [];
    for (const batch of batches) {
      const { data: createdBatch } = await mutateAsync({
        resource: "email_batches",
        values: {
          class_id: course_id,
          subject: batch.subject ?? "",
          body: batch.body ?? "",
          cc_emails: {
            emails: batch.cc_ids.map((cc) => cc.email)
          },
          reply_to: batch.reply_to
        }
      });

      const emailsForBatch = emailsToCreate.filter((email) => {
        return email.batch_id == batch.id;
      });

      emailsForBatch.forEach((email) => {
        emailsFormatted.push({
          user_id: email.to.user_id,
          class_id: Number(course_id),
          batch_id: Number(createdBatch.id),
          subject: email.subject ?? "",
          body: email.body ?? "",
          cc_emails: {
            emails: email.cc_ids.map((cc) => cc.email) ?? []
          },
          reply_to: email.reply_to
        });
      });
    }
    await mutateAsync({
      resource: "emails",
      values: emailsFormatted
    })
      .then(() => {
        invalidate({
          resource: "email_batches",
          invalidates: ["list"]
        });
        toaster.success({
          title: "Successfully created emails",
          description: `Created ${emailsToCreate.length} emails`
        });
      })
      .catch((e) => {
        toaster.error({
          title: "Error creating emails",
          description: `Failed to create emails: ${e}`
        });
      });

    clearEmails();
  };

  return (
    <Box width={{ base: "100%" }}>
      <Heading size="lg" mt="5" mb="5">
        Preview and send
      </Heading>
      {emailsToCreate.length > 0 ? (
        <Box spaceY="4">
          <EmailListWithPagination userRoles={userRoles} />
          <Button
            onClick={() => {
              sendEmails();
            }}
          >
            Send emails
          </Button>
        </Box>
      ) : (
        <Text>No emails drafted at this time</Text>
      )}
    </Box>
  );
}

const EmailListWithPagination = ({ userRoles }: { userRoles?: UserRoleWithUserDetails[] }) => {
  const { emailsToCreate, removeEmail, updateEmailField } = useEmailManagement();
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(5);

  // Calculate pagination values
  const totalItems = emailsToCreate.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;

  // Get current page items
  const currentEmails = useMemo(() => {
    return emailsToCreate.slice(startIndex, endIndex);
  }, [emailsToCreate, startIndex, endIndex]);

  // Handle page change
  const handlePageChange = (page: SetStateAction<number>) => {
    setCurrentPage(page);
  };

  // Handle items per page change
  const handleItemsPerPageChange = (value: number) => {
    setItemsPerPage(Number(value));
    setCurrentPage(1); // Reset to first page
  };

  // Generate page numbers for navigation
  const getPageNumbers = () => {
    const pages = [];
    const maxVisiblePages = 5;
    if (totalPages <= maxVisiblePages) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      const start = Math.max(1, currentPage - 2);
      const end = Math.min(totalPages, start + maxVisiblePages - 1);

      for (let i = start; i <= end; i++) {
        pages.push(i);
      }
    }
    return pages;
  };

  return (
    <Box>
      {/* Pagination Controls - Top */}
      <Flex alignItems="center" mb={4} gap={4}>
        <Text fontSize="sm" color="gray.600">
          Showing {startIndex + 1}-{Math.min(endIndex, totalItems)} of {totalItems} emails
        </Text>
        <Spacer />
        <Flex alignItems="center" gap={2}>
          <Text fontSize="sm">Show:</Text>
          <Select
            size="sm"
            value={{ label: itemsPerPage, value: itemsPerPage }}
            onChange={(e) => (e ? handleItemsPerPageChange(e.value) : null)}
            options={[5, 10, 20, 30].map((num) => {
              return { label: num, value: num };
            })}
          />
          <Text fontSize="sm">per page</Text>
        </Flex>
      </Flex>

      {/* Email List */}
      {currentEmails.map((email, key) => {
        return (
          <Card.Root key={email.id || key} padding="2" mt="5" size="sm">
            <Flex justifyContent={"space-between"}>
              <Card.Title width="80%">
                <Flex alignItems="center">
                  Subject:
                  <Editable.Root
                    value={email.subject}
                    onValueChange={(e) => {
                      if (email.id) {
                        updateEmailField(email.id, "subject", e.value);
                      }
                    }}
                  >
                    <Editable.Preview />
                    <Editable.Input />
                  </Editable.Root>
                </Flex>
              </Card.Title>
              <Text
                onClick={() => {
                  if (email.id) {
                    removeEmail(email.id);
                  }
                }}
                cursor="pointer"
              >
                <IoMdClose />
              </Text>
            </Flex>
            <Flex flexDir={"column"} fontSize="sm">
              <Box>To: {email.to.email}</Box>

              <Flex gap="1" alignItems={"center"}>
                Cc:{" "}
                <CreatableSelect
                  value={email.cc_ids.map((cc) => ({ label: cc.email, value: cc.user_id }))}
                  onChange={(e) =>
                    updateEmailField(
                      email.id,
                      "cc_ids",
                      Array.from(e).map((elem) => ({ email: elem.label, user_id: elem.value }))
                    )
                  }
                  isMulti={true}
                  options={userRoles
                    ?.filter((item) => {
                      return item.user_id !== email.to.user_id;
                    })
                    .map((a) => ({ label: a.users.email, value: a.users.user_id }))}
                  placeholder="Select or type email addresses..."
                />
              </Flex>
              <Box>Reply to: {email.reply_to ?? "General Pawtograder email"}</Box>
              <Flex alignItems="center" gap="2">
                <Box>Why: {email.why}</Box>{" "}
                <ToggleTip size="xs" content="We won't share this with the recipient">
                  <Button size="xs" variant="ghost">
                    <LuInfo />
                  </Button>
                </ToggleTip>
              </Flex>
              <Flex alignItems="center">
                Body:
                <Editable.Root
                  value={email.body}
                  onValueChange={(e) => {
                    if (email.id) {
                      updateEmailField(email.id, "body", e.value);
                    }
                  }}
                >
                  <Editable.Preview />
                  <Editable.Input />
                </Editable.Root>
              </Flex>
            </Flex>
          </Card.Root>
        );
      })}

      {/* Pagination Controls - Bottom */}
      {totalPages > 1 && (
        <Flex justifyContent="center" alignItems="center" mt={6} gap={2}>
          {/* Previous Button */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1}
          >
            Previous
          </Button>

          {/* Page Numbers */}
          <HStack>
            {/* First page if not visible */}
            {getPageNumbers()[0] > 1 && (
              <>
                <Button size="sm" variant={1 === currentPage ? "solid" : "outline"} onClick={() => handlePageChange(1)}>
                  1
                </Button>
                {getPageNumbers()[0] > 2 && <Text>...</Text>}
              </>
            )}

            {/* Visible page numbers */}
            {getPageNumbers().map((page) => (
              <Button
                key={page}
                size="sm"
                variant={page === currentPage ? "solid" : "outline"}
                onClick={() => handlePageChange(page)}
                colorPalette={page === currentPage ? "blue" : "gray"}
              >
                {page}
              </Button>
            ))}

            {/* Last page if not visible */}
            {getPageNumbers()[getPageNumbers().length - 1] < totalPages && (
              <>
                {getPageNumbers()[getPageNumbers().length - 1] < totalPages - 1 && <Text>...</Text>}
                <Button
                  size="sm"
                  variant={totalPages === currentPage ? "solid" : "outline"}
                  onClick={() => handlePageChange(totalPages)}
                >
                  {totalPages}
                </Button>
              </>
            )}
          </HStack>

          {/* Next Button */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
          >
            Next
          </Button>
        </Flex>
      )}
    </Box>
  );
};

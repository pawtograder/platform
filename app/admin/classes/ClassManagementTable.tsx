"use client";

import { Button } from "@/components/ui/button";
import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { AdminGetClassesResponse } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Card, Flex, HStack, Table, Text, VStack } from "@chakra-ui/react";
import { MoreHorizontal, Pencil, Settings, Trash2, Users } from "lucide-react";
import { useState } from "react";
import EditClassModal from "./EditClassModal";
import SectionManagementModal from "./SectionManagementModal";

type Class = AdminGetClassesResponse[0];
interface ClassManagementTableProps {
  classes: Class[];
}

export default function ClassManagementTable({ classes: initialClasses }: ClassManagementTableProps) {
  const [classes, setClasses] = useState<Class[]>(initialClasses);
  const [editingClass, setEditingClass] = useState<Class | null>(null);
  const [managingSectionsClass, setManagingSectionsClass] = useState<Class | null>(null);
  const [isDeleting, setIsDeleting] = useState<number | null>(null);

  const supabase = createClient();

  const handleDelete = async (classId: number) => {
    setIsDeleting(classId);
    try {
      const { error } = await supabase.rpc("admin_delete_class", {
        p_class_id: classId
      });

      if (error) throw error;

      // Update local state
      setClasses(classes.map((c) => (c.id === classId ? { ...c, archived: true } : c)));

      toaster.create({
        title: "Class Archived",
        description: "The class has been archived successfully.",
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to archive class",
        type: "error"
      });
    } finally {
      setIsDeleting(null);
    }
  };

  const handleClassUpdated = (updatedClass: Class) => {
    setClasses(classes.map((c) => (c.id === updatedClass.id ? updatedClass : c)));
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  };

  return (
    <>
      <Card.Root>
        <Card.Header>
          <Card.Title>All Classes</Card.Title>
          <Text color="fg.muted">
            Manage all classes in the system. You can edit settings, manage sections, and archive classes.
          </Text>
        </Card.Header>
        <Card.Body>
          {classes.length === 0 ? (
            <Box textAlign="center" py={8}>
              <Text color="fg.subtle">No classes found.</Text>
            </Box>
          ) : (
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Class</Table.ColumnHeader>
                  <Table.ColumnHeader>Term</Table.ColumnHeader>
                  <Table.ColumnHeader>Enrollments</Table.ColumnHeader>

                  <Table.ColumnHeader>GitHub Org</Table.ColumnHeader>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                  <Table.ColumnHeader>Created</Table.ColumnHeader>
                  <Table.ColumnHeader w="100px">Actions</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {classes.map((class_) => (
                  <Table.Row key={class_.id}>
                    <Table.Cell>
                      <VStack align="start" gap={1}>
                        <Text fontWeight="medium">{class_.name}</Text>
                        {class_.description && (
                          <Text fontSize="sm" color="fg.subtle">
                            {class_.description}
                          </Text>
                        )}
                      </VStack>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontWeight="medium">{class_.term}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex gap={2}>
                        <Badge colorPalette="blue">
                          <HStack gap={1}>
                            <Users size={12} />
                            <Text>{class_.student_count} students</Text>
                          </HStack>
                        </Badge>
                        <Badge variant="outline">{class_.instructor_count} instructors</Badge>
                      </Flex>
                    </Table.Cell>

                    <Table.Cell>{class_.github_org_name || <Text color="gray.500">—</Text>}</Table.Cell>
                    <Table.Cell>
                      <Badge colorPalette={class_.archived ? "gray" : "green"}>
                        {class_.archived ? "Archived" : "Active"}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>{formatDate(class_.created_at)}</Table.Cell>
                    <Table.Cell>
                      <MenuRoot>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal size={16} />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem value="edit" onClick={() => setEditingClass(class_)}>
                            <HStack>
                              <Pencil size={16} />
                              <Text>Edit Settings</Text>
                            </HStack>
                          </MenuItem>
                          <MenuItem value="sections" onClick={() => setManagingSectionsClass(class_)}>
                            <HStack>
                              <Settings size={16} />
                              <Text>Manage Sections</Text>
                            </HStack>
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            value="delete"
                            onClick={() => handleDelete(class_.id)}
                            disabled={isDeleting === class_.id || class_.archived === true}
                            color="red.500"
                          >
                            <HStack>
                              <Trash2 size={16} />
                              <Text>{isDeleting === class_.id ? "Archiving..." : "Archive Class"}</Text>
                            </HStack>
                          </MenuItem>
                        </MenuContent>
                      </MenuRoot>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Card.Body>
      </Card.Root>

      {/* Edit Class Modal */}
      {editingClass && (
        <EditClassModal
          class_={editingClass}
          open={!!editingClass}
          onOpenChange={(open) => !open && setEditingClass(null)}
          onClassUpdated={handleClassUpdated}
        />
      )}

      {/* Section Management Modal */}
      {managingSectionsClass && (
        <SectionManagementModal
          class_={managingSectionsClass}
          open={!!managingSectionsClass}
          onOpenChange={(open) => !open && setManagingSectionsClass(null)}
        />
      )}
    </>
  );
}

"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogContent, DialogHeader, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCallback, useEffect, useState } from "react";

import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { AdminGetClassesResponse } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, HStack, Table, Text, VStack } from "@chakra-ui/react";
import { MoreHorizontal, Pencil, Plus, Trash2, Users } from "lucide-react";

type Class = AdminGetClassesResponse[0];

interface Section {
  section_id: number;
  section_name: string;
  section_type: "class" | "lab";
  meeting_location: string | null;
  meeting_times: string | null;
  campus: string | null;
  sis_crn: number | null;
  created_at: string;
  updated_at: string;
  member_count: number;
}

interface SectionManagementModalProps {
  class_: Class;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SectionManagementModal({ class_, open, onOpenChange }: SectionManagementModalProps) {
  const [sections, setSections] = useState<Section[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState<"class" | "lab" | null>(null);
  const [newSectionName, setNewSectionName] = useState("");
  const [editingSection, setEditingSection] = useState<Section | null>(null);
  const [editName, setEditName] = useState("");

  const loadSections = useCallback(async () => {
    const supabase = createClient();
    setIsLoading(true);
    try {
      const { data, error } = await supabase.rpc("admin_get_class_sections", {
        p_class_id: class_.id
      });

      if (error) throw error;
      setSections((data as Section[]) || []);
    } catch (error) {
      console.error("Error loading sections:", error);
      toaster.create({
        title: "Error",
        description: "Failed to load sections",
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  }, [class_.id]);
  // Load sections when modal opens
  useEffect(() => {
    if (open && class_.id) {
      loadSections();
    }
  }, [open, class_.id, loadSections]);

  const handleCreateSection = useCallback(
    async (type: "class" | "lab") => {
      const supabase = createClient();
      if (!newSectionName.trim()) {
        toaster.create({
          title: "Error",
          description: "Section name is required",
          type: "error"
        });
        return;
      }

      try {
        const functionName = type === "class" ? "admin_create_class_section" : "admin_create_lab_section";

        const { error } = await supabase.rpc(functionName, {
          p_class_id: class_.id,
          p_name: newSectionName.trim()
        });

        if (error) throw error;

        toaster.create({
          title: "Section Created",
          description: `${type === "class" ? "Class" : "Lab"} section "${newSectionName}" has been created.`,
          type: "success"
        });

        // Reset form and reload sections
        setNewSectionName("");
        setIsCreating(null);
        loadSections();
      } catch (error) {
        console.error("Error creating section:", error);
        toaster.create({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to create section",
          type: "error"
        });
      }
    },
    [class_.id, newSectionName, loadSections]
  );

  const handleUpdateSection = useCallback(
    async (section: Section) => {
      const supabase = createClient();
      if (!editName.trim()) {
        toaster.create({
          title: "Error",
          description: "Section name is required",
          type: "error"
        });
        return;
      }

      try {
        const functionName =
          section.section_type === "class" ? "admin_update_class_section" : "admin_update_lab_section";

        const { error } = await supabase.rpc(functionName, {
          p_section_id: section.section_id,
          p_name: editName.trim()
        });

        if (error) throw error;

        toaster.create({
          title: "Section Updated",
          description: `Section has been updated to "${editName}".`,
          type: "success"
        });

        // Reset form and reload sections
        setEditingSection(null);
        setEditName("");
        loadSections();
      } catch (error) {
        console.error("Error updating section:", error);
        toaster.create({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to update section",
          type: "error"
        });
      }
    },
    [editName, loadSections]
  );

  const handleDeleteSection = useCallback(
    async (section: Section) => {
      const supabase = createClient();
      if (section.member_count > 0) {
        toaster.create({
          title: "Cannot Delete",
          description: "Cannot delete a section that has members. Please move members first.",
          type: "error"
        });
        return;
      }

      try {
        const functionName =
          section.section_type === "class" ? "admin_delete_class_section" : "admin_delete_lab_section";

        const { error } = await supabase.rpc(functionName, {
          p_section_id: section.section_id
        });

        if (error) throw error;

        toaster.create({
          title: "Section Deleted",
          description: `Section "${section.section_name}" has been deleted.`,
          type: "success"
        });

        loadSections();
      } catch (error) {
        console.error("Error deleting section:", error);
        toaster.create({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to delete section",
          type: "error"
        });
      }
    },
    [loadSections]
  );

  const startEdit = (section: Section) => {
    setEditingSection(section);
    setEditName(section.section_name);
  };

  const cancelEdit = () => {
    setEditingSection(null);
    setEditName("");
  };

  return (
    <DialogRoot open={open} onOpenChange={(e) => onOpenChange(e.open)}>
      <DialogContent maxW="700px">
        <DialogHeader>
          <DialogTitle>Manage Sections - {class_.name}</DialogTitle>
          <Text color="fg.muted">Create and manage class sections and lab sections for {class_.term}.</Text>
        </DialogHeader>

        <DialogBody>
          <VStack gap={6}>
            {/* Create Section Form */}
            <VStack gap={4} w="full">
              <VStack align="start" w="full">
                <Label htmlFor="newSection">Create New Section</Label>
                <HStack gap={2} w="full">
                  <Input
                    id="newSection"
                    value={newSectionName}
                    onChange={(e) => setNewSectionName(e.target.value)}
                    placeholder="e.g., Section 01, Lab A"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && isCreating) {
                        handleCreateSection(isCreating);
                      }
                    }}
                    flex={1}
                  />
                  <Button
                    onClick={() => setIsCreating("class")}
                    disabled={!newSectionName.trim() || isCreating === "class"}
                    size="sm"
                  >
                    <HStack gap={1}>
                      <Plus size={16} />
                      <Text>Class Section</Text>
                    </HStack>
                  </Button>
                  <Button
                    onClick={() => setIsCreating("lab")}
                    disabled={!newSectionName.trim() || isCreating === "lab"}
                    size="sm"
                  >
                    <HStack gap={1}>
                      <Plus size={16} />
                      <Text>Lab Section</Text>
                    </HStack>
                  </Button>
                </HStack>
              </VStack>

              {isCreating && (
                <HStack gap={2}>
                  <Button onClick={() => handleCreateSection(isCreating)} disabled={!newSectionName.trim()}>
                    Create {isCreating === "class" ? "Class" : "Lab"} Section
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsCreating(null);
                      setNewSectionName("");
                    }}
                  >
                    Cancel
                  </Button>
                </HStack>
              )}
            </VStack>

            {/* Sections Table */}
            <Box w="full">
              {isLoading ? (
                <Box textAlign="center" py={4}>
                  <Text>Loading sections...</Text>
                </Box>
              ) : sections.length === 0 ? (
                <Box textAlign="center" py={8}>
                  <Text color="fg.subtle">No sections created yet.</Text>
                </Box>
              ) : (
                <Table.Root>
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Section Name</Table.ColumnHeader>
                      <Table.ColumnHeader>Type</Table.ColumnHeader>
                      <Table.ColumnHeader>Meeting Info</Table.ColumnHeader>
                      <Table.ColumnHeader>Location</Table.ColumnHeader>
                      <Table.ColumnHeader>Campus</Table.ColumnHeader>
                      <Table.ColumnHeader>Members</Table.ColumnHeader>
                      <Table.ColumnHeader>Created</Table.ColumnHeader>
                      <Table.ColumnHeader w="100px">Actions</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {sections.map((section) => (
                      <Table.Row key={`${section.section_type}-${section.section_id}`}>
                        <Table.Cell>
                          {editingSection?.section_id === section.section_id ? (
                            <HStack gap={2}>
                              <Input
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    handleUpdateSection(section);
                                  } else if (e.key === "Escape") {
                                    cancelEdit();
                                  }
                                }}
                              />
                              <Button size="sm" onClick={() => handleUpdateSection(section)}>
                                Save
                              </Button>
                              <Button size="sm" variant="outline" onClick={cancelEdit}>
                                Cancel
                              </Button>
                            </HStack>
                          ) : (
                            <Text fontWeight="medium">{section.section_name}</Text>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <Badge colorPalette={section.section_type === "class" ? "blue" : "green"}>
                            {section.section_type === "class" ? "Class" : "Lab"}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>
                          <HStack gap={1}>
                            <Users size={16} />
                            <Text>{section.member_count}</Text>
                          </HStack>
                        </Table.Cell>
                        <Table.Cell>
                          <TimeZoneAwareDate date={section.created_at} format="dateOnly" />
                        </Table.Cell>
                        <Table.Cell>
                          {editingSection?.section_id !== section.section_id && (
                            <MenuRoot>
                              <MenuTrigger asChild>
                                <Button variant="ghost" size="sm">
                                  <MoreHorizontal size={16} />
                                </Button>
                              </MenuTrigger>
                              <MenuContent>
                                <MenuItem value="edit" onClick={() => startEdit(section)}>
                                  <HStack>
                                    <Pencil size={16} />
                                    <Text>Edit Name</Text>
                                  </HStack>
                                </MenuItem>
                                <MenuItem
                                  value="delete"
                                  onClick={() => handleDeleteSection(section)}
                                  disabled={section.member_count > 0}
                                  color="red.500"
                                >
                                  <HStack>
                                    <Trash2 size={16} />
                                    <Text>Delete</Text>
                                  </HStack>
                                </MenuItem>
                              </MenuContent>
                            </MenuRoot>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              )}
            </Box>
          </VStack>
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}

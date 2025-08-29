"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { VStack, HStack, Text, Textarea } from "@chakra-ui/react";
import type { AdminGetClassesResponse } from "@/utils/supabase/DatabaseTypes";
import { TermSelector } from "@/components/ui/term-selector";

type Class = AdminGetClassesResponse[0];
interface EditClassModalProps {
  class_: Class;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClassUpdated?: (updatedClass: Class) => void;
}

export default function EditClassModal({ class_, open, onOpenChange, onClassUpdated }: EditClassModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    term: 0,
    description: "",
    github_org_name: "",
    github_template_prefix: ""
  });

  const supabase = createClient();

  // Initialize form data when class prop changes
  useEffect(() => {
    if (class_) {
      setFormData({
        name: class_.name || "",
        term: class_.term || 0,
        description: class_.description || "",
        github_org_name: class_.github_org_name || "",
        github_template_prefix: class_.github_template_prefix || ""
      });
    }
  }, [class_]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // Validate required fields
      if (!formData.name.trim() || !formData.term) {
        throw new Error("Name and term are required");
      }

      const { error } = await supabase.rpc("admin_update_class", {
        p_class_id: class_.id,
        p_name: formData.name.trim(),
        p_term: formData.term,
        p_description: formData.description.trim() || undefined,
        p_github_org_name: formData.github_org_name.trim() || undefined,
        p_github_template_prefix: formData.github_template_prefix.trim() || undefined
      });

      if (error) throw error;

      toaster.create({
        title: "Class Updated",
        description: `${formData.name} has been updated successfully.`,
        type: "success"
      });

      // Call the callback with updated class data
      if (onClassUpdated) {
        onClassUpdated({
          ...class_,
          name: formData.name.trim(),
          term: formData.term,
          description: formData.description.trim() || "",
          github_org_name: formData.github_org_name.trim() || "",
          github_template_prefix: formData.github_template_prefix.trim() || "",
          created_at: class_.created_at,
          student_count: class_.student_count,
          instructor_count: class_.instructor_count,
          archived: class_.archived
        });
      }

      onOpenChange(false);
    } catch (error) {
      toaster.create({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update class",
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (field: string, value: string | number) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <DialogRoot open={open} onOpenChange={(e) => onOpenChange(e.open)}>
      <DialogContent maxW="500px">
        <DialogHeader>
          <DialogTitle>Edit Class</DialogTitle>
          <Text color="fg.muted">Update the class information below.</Text>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit}>
            <VStack gap={4}>
              <HStack gap={4} w="full">
                <VStack align="start" flex={1}>
                  <Label htmlFor="name">Class Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => handleInputChange("name", e.target.value)}
                    placeholder="e.g., CS 2500"
                    required
                  />
                </VStack>
                <VStack align="start" flex={1}>
                  <TermSelector
                    value={formData.term}
                    onChange={(value: number) => handleInputChange("term", value)}
                    label="Term"
                    required
                  />
                </VStack>
              </HStack>

              <VStack align="start" w="full">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    handleInputChange("description", e.target.value)
                  }
                  placeholder="Brief description of the course..."
                  rows={3}
                />
              </VStack>

              <HStack gap={4} w="full">
                <VStack align="start" flex={1}>
                  <Label htmlFor="github_org_name">GitHub Organization</Label>
                  <Input
                    id="github_org_name"
                    value={formData.github_org_name}
                    onChange={(e) => handleInputChange("github_org_name", e.target.value)}
                    placeholder="e.g., cs2500-fall2024"
                  />
                </VStack>
                <VStack align="start" flex={1}>
                  <Label htmlFor="github_template_prefix">Template Prefix</Label>
                  <Input
                    id="github_template_prefix"
                    value={formData.github_template_prefix}
                    onChange={(e) => handleInputChange("github_template_prefix", e.target.value)}
                    placeholder="e.g., hw"
                  />
                </VStack>
              </HStack>
            </VStack>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isLoading}>
            {isLoading ? "Updating..." : "Update Class"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

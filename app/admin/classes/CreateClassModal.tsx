"use client";

import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TermSelector } from "@/components/ui/term-selector";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { HStack, Text, Textarea, VStack } from "@chakra-ui/react";
import { useState } from "react";

interface CreateClassModalProps {
  children: React.ReactNode;
}

export default function CreateClassModal({ children }: CreateClassModalProps) {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    term: parseInt(`${new Date().getFullYear()}10`), // Default to current year + fall (10)
    description: "",
    canvas_course_id: "",
    github_org_name: "",
    github_template_prefix: ""
  });

  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // Validate required fields
      if (!formData.name.trim() || !formData.term) {
        throw new Error("Name and term are required");
      }

      const { error } = await supabase.rpc("admin_create_class", {
        p_name: formData.name.trim(),
        p_term: formData.term,
        p_description: formData.description.trim() || undefined,

        p_github_org_name: formData.github_org_name.trim() || undefined,
        p_github_template_prefix: formData.github_template_prefix.trim() || undefined
      });

      if (error) throw error;

      toaster.create({
        title: "Class Created",
        description: `${formData.name} has been created successfully.`,
        type: "success"
      });

      // Reset form and close modal
      setFormData({
        name: "",
        term: parseInt(`${new Date().getFullYear()}10`), // Default to current year + fall (10)
        description: "",
        canvas_course_id: "",
        github_org_name: "",
        github_template_prefix: ""
      });
      setOpen(false);

      // Refresh the page to show new class
      window.location.reload();
    } catch (error) {
      toaster.create({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create class",
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
    <DialogRoot open={open} onOpenChange={(e) => setOpen(e.open)}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent maxW="500px">
        <DialogHeader>
          <DialogTitle>Create New Class</DialogTitle>
          <Text color="fg.muted">Add a new class to the system. Fill in the basic information below.</Text>
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

              <VStack align="start" w="full">
                <Label htmlFor="canvas_course_id">Canvas Course ID</Label>
                <Input
                  id="canvas_course_id"
                  value={formData.canvas_course_id}
                  onChange={(e) => handleInputChange("canvas_course_id", e.target.value)}
                  placeholder="e.g., 12345"
                  type="number"
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
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isLoading}>
            {isLoading ? "Creating..." : "Create Class"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

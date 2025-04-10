'use client';

import { useParams } from "next/navigation";
import { useForm } from "@refinedev/react-hook-form";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Container, createListCollection, Fieldset, Heading, ListCollection } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";
import { ListReposResponse } from "@/components/github/GitHubTypes";
import { githubRepoConfigureWebhook, repositoriesForClass } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import AssignmentForm from "../../new/form";
import { FieldValues } from "react-hook-form";
import { assignmentGroupCopyGroupsFromAssignment } from "@/lib/edgeFunctions";
export default function EditAssignment() {
    const { course_id, assignment_id } = useParams();
    const form = useForm<Assignment>({
        refineCoreProps: {
            resource: "assignments",
            action: "edit",
            id: Number.parseInt(assignment_id as string)
        }
    });
    const onFinish = useCallback(async (values: FieldValues) => {
        const supabase = createClient();
        if (values.copy_groups_from_assignment !== undefined) {
            if (values.copy_groups_from_assignment !== "") {
                await assignmentGroupCopyGroupsFromAssignment(
                    {
                        source_assignment_id: values.copy_groups_from_assignment,
                        target_assignment_id: Number.parseInt(assignment_id as string),
                        class_id: Number.parseInt(course_id as string)
                    },
                    supabase
                )
            }
            delete values.copy_groups_from_assignment;
        }
        await form.refineCore.onFinish(values);
        if (values.template_repo) {
            await githubRepoConfigureWebhook(
                {
                    assignment_id: Number.parseInt(assignment_id as string),
                    new_repo: values.template_repo,
                    watch_type: "template_repo"
                },
                supabase
            )
        }
    }, [form.refineCore]);
    if (form.refineCore.formLoading) {
        return <div>Loading...</div>
    }
    if (form.refineCore.query?.error) {
        return <div>Error: {form.refineCore.query.error.message}</div>
    }
    return <Container maxW="container.xl">
        <Heading size="2xl">Edit Assignment</Heading>
        <AssignmentForm form={form} onSubmit={onFinish} />
    </Container>
}
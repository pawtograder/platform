'use client';

import { Icon, Button, Input, Dialog, Popover, Field, Select, NativeSelect } from "@chakra-ui/react";
import { FaPlus } from "react-icons/fa";
import { useForm } from "react-hook-form";
import { fetchAddEnrollment } from "@/lib/generated/pawtograderComponents";
import { useParams } from "next/navigation";
import { useInvalidate } from "@refinedev/core";
import { useCallback } from "react";
export default function AddSingleStudent() {
    const { course_id } = useParams();
    const { register, handleSubmit, formState: { errors },
    } = useForm();
    const invalidate = useInvalidate();
    const onSubmit = useCallback(async (data: any) => {
        console.log("Submitting");
        await fetchAddEnrollment({
            pathParams: {
                courseId: Number(course_id),
            },
            body: {
                email: data.email,
                name: data.name,
                role: data.role,
            },
        });
        console.log("Invalidating user_roles");
        invalidate({
            resource: "user_roles",
            invalidates: ["list"],
        });
    }, [course_id, invalidate]);
    return <Dialog.Root>
        <Dialog.Trigger asChild>
            <Button marginLeft="auto"><Icon as={FaPlus} />Add Course Member</Button>
        </Dialog.Trigger>
        <Dialog.Backdrop />
        <Dialog.Positioner>
            <Dialog.Content>
                <Dialog.CloseTrigger />
                <Dialog.Header>
                    <Dialog.Title>Add Course Member</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                    <form onSubmit={handleSubmit(onSubmit)}>
                        <Field.Root invalid={!!errors.email}>
                            <Field.Label>Email</Field.Label>
                            <Input placeholder="Email" {...register("email", { required: true })} />
                            <Field.ErrorText>{errors.email?.message as string}</Field.ErrorText>
                        </Field.Root>
                        <Field.Root invalid={!!errors.name}>
                            <Field.Label>Name</Field.Label>
                            <Input placeholder="Name" {...register("name", { required: true })} />
                            <Field.ErrorText>{errors.name?.message as string}</Field.ErrorText>
                        </Field.Root>
                        <Field.Root invalid={!!errors.role}>
                            <Field.Label>Role</Field.Label>
                            <NativeSelect.Root>
                                <NativeSelect.Field {...register("role", { required: true })}>
                                    <option value="student">Student</option>
                                    <option value="grader">Grader</option>
                                    <option value="instructor">Instructor</option>
                                </NativeSelect.Field>
                            </NativeSelect.Root>
                            <Field.ErrorText>{errors.role?.message as string}</Field.ErrorText>
                        </Field.Root>
                        <Button type="submit">Add Student</Button>
                    </form>
                </Dialog.Body>
            </Dialog.Content>
        </Dialog.Positioner>
    </Dialog.Root>
}
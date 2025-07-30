// 'use client'

import { Box } from "@chakra-ui/react";

import React from "react";

import { CourseControllerProvider } from "@/hooks/useCourseController";
import DynamicCourseNav from "./dynamicCourseNav";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";

const ProtectedLayout = async ({
  children,
  params
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}>) => {
  const { course_id } = await params;
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/");
  }
  const { data: user_role } = await supabase
    .from("user_roles")
    .select("private_profile_id, role")
    .eq("user_id", user.id)
    .eq("class_id", Number.parseInt(course_id))
    .single();
  if (!user_role) {
    redirect("/");
  }
  // const {open, onOpen, onClose} = useDisclosure()
  return (
    <Box minH="100vh">
      <CourseControllerProvider
        course_id={Number.parseInt(course_id)}
        profile_id={user_role.private_profile_id}
        role={user_role.role}
      >
        <DynamicCourseNav />
        {/* <SidebarContent courseID={Number.parseInt(course_id)} /> */}
        {/* mobilenav */}
        <Box pt="0" ml="0" mr="0">
          {children}
        </Box>
      </CourseControllerProvider>
    </Box>
  );
};

export default ProtectedLayout;

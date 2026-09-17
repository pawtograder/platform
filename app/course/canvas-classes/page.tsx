"use client";

import { Box, Heading, Text } from "@chakra-ui/react";

// import { useCallback, useEffect, useState } from "react";

export default function CanvasClasses() {
  // const [courses, setCourses] = useState<GetCanvasCoursesResponse>([]);
  // useEffect(() => {
  //     const fetchCourses = async () => {
  //         const courses = await fetchGetCanvasCourses({});
  //         //TODO - also fetch data from supabase. store in state, and render it as a table
  //         setCourses(courses);
  //     };
  //     fetchCourses();
  // }, []);
  // const createCourseForCanvasCourse = useCallback(async (courseId: number) => {
  //     fetchCreateCourseForCanvasCourse({ pathParams: { courseId } });
  // }, []);

  // return (
  //     <div>
  //         {
  //             courses.map((course) => (
  //                 <div key={course.id}>
  //                     <h2>{course.name}</h2>
  //                     <a href="#" onClick={() => createCourseForCanvasCourse(course.id)}>Create course for canvas</a>

  //                 </div>
  //             ))
  //         }
  //     </div>
  // );
  // Placeholder page, but it is routable and reachable, so it still owes a
  // <main> landmark — it renders outside the course layout that supplies one,
  // and the global skip link targets #main-content.
  return (
    <Box as="main" id="main-content" tabIndex={-1} p={4}>
      <Heading as="h1" size="lg">
        Canvas classes
      </Heading>
      <Text>WIP</Text>
    </Box>
  );
}

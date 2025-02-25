'use client';

import { Button } from "@chakra-ui/react";
import { fetchCreateGitHubReposForStudent } from "@/lib/generated/pawtograderComponents";
export default function CreateStudentReposButton() {
    return <Button onClick={() => fetchCreateGitHubReposForStudent({})}>Create GitHub Repositories</Button>
}
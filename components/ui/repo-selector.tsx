import { Field, Skeleton } from "@chakra-ui/react";

import { repositoriesForClass } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
export default function RepoSelector({
  name,
  value,
  onBlur,
  onChange,
  templateReposOnly
}: {
  name: string;
  value: string;
  onBlur: () => void;
  onChange: (value: string) => void;
  templateReposOnly?: boolean;
}) {
  const { course_id } = useParams();
  const [templateReposList, setTemplateReposList] = useState<{ label: string; value: string }[]>();
  useEffect(() => {
    async function fetchRepos() {
      const supabase = createClient();
      const repos = await repositoriesForClass(
        { courseId: Number(course_id), template_only: templateReposOnly },
        supabase
      );
      repos.sort((a, b) => a.owner.login.localeCompare(b.owner.login) || a.name.localeCompare(b.name));
      setTemplateReposList(
        repos.map((repo) => {
          return {
            label: `${repo.owner.login}/${repo.name}`,
            value: `${repo.owner.login}/${repo.name}`
          };
        })
      );
    }
    fetchRepos();
  }, []);
  if (!templateReposList) return <Skeleton height="20px" />;
  return (
    <Field.Root>
      <Field.Label>Repository</Field.Label>
      <Select
        name={name}
        onBlur={onBlur}
        value={{ label: value, value: value }}
        isMulti={false}
        onChange={(e) => {
          if (e) {
            onChange(e.value);
          }
        }}
        options={templateReposList}
      />
    </Field.Root>
  );
}

"use client";

import { createClient } from "@/utils/supabase/client";
import { useEffect, useState } from "react";
import { ListReposResponse } from "./GitHubTypes";
import {
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectRoot,
  SelectTrigger,
  SelectValueText
} from "@/components/ui/select";
import { createListCollection } from "@chakra-ui/react";
import { Database } from "@/utils/supabase/SupabaseTypes";

export type RepoPickerParams = Parameters<typeof SelectRoot> & {
  course: Database["public"]["Tables"]["classes"]["Row"];
};
export default function RepoPicker(params: RepoPickerParams) {
  const { course } = params;
  const [templateRepos, setTemplateRepos] = useState<ListReposResponse>();

  useEffect(() => {
    const fetchRepos = async () => {
      const supabase = await createClient();
      const session = await supabase.auth.getSession();
      const response = await fetch(`http://localhost:3100/api/course/${course.id}/template-repos`, {
        headers: { Authorization: `${session.data.session?.access_token}` }
      });
      const data = (await response.json()) as ListReposResponse;
      setTemplateRepos(data);
    };
    fetchRepos();
  }, [course.id]);

  if (!templateRepos) {
    return <div>Loading...</div>;
  }
  const reposCollection = createListCollection({ items: templateRepos, itemToString: (repo) => repo.name });
  return (
    <SelectRoot collection={reposCollection}>
      <SelectLabel>Repository</SelectLabel>
      <SelectTrigger>
        <SelectValueText placeholder="..." />
      </SelectTrigger>
      <SelectContent>
        {reposCollection.items.map((repo) => (
          <SelectItem key={repo.id} item={repo}>
            {repo.name}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

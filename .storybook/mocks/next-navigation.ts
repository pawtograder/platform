import { useMemo } from "react";

export function usePathname() {
  return "/course/1/assignments/1/submissions/1/files";
}

export function useRouter() {
  return {
    push: (_url: string) => {},
    replace: (_url: string) => {},
    back: () => {}
  } as const;
}

export function useSearchParams() {
  const params = useMemo(() => new URLSearchParams(), []);
  return {
    get: (key: string) => params.get(key),
    toString: () => params.toString(),
    set: (key: string, value: string) => params.set(key, value),
    delete: (key: string) => params.delete(key)
  } as unknown as ReturnType<typeof URLSearchParams>;
}

export function useParams() {
  return {
    course_id: "1",
    assignment_id: "1",
    submissions_id: "1"
  } as const;
}

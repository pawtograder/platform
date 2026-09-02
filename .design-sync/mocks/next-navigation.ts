/* eslint-disable @typescript-eslint/no-explicit-any */
// Mock of next/navigation for the offline preview (no Next router).
export function usePathname(): string {
  return "/course/1/assignments/1/submissions/1/files";
}
export function useSearchParams(): any {
  return new URLSearchParams("");
}
export function useParams(): any {
  return { course_id: "1", assignment_id: "1", submissions_id: "1" };
}
export function useRouter(): any {
  return { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
}

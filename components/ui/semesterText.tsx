export function termToTermText(term: number): string {
  const year = Math.floor(term / 100);
  const termCode = term % 100;
  const termMap: Record<number, string> = {
    10: "Fall",
    20: "Spring",
    30: "Summer 1",
    40: "Summer 2"
  };
  const name = termMap[termCode] ?? `Term ${termCode}`;
  return `${name} ${year}`;
}
export default function SemesterText({ semester }: { semester: number | null }) {
  if (!semester) {
    return <></>;
  }
  return termToTermText(semester);
}

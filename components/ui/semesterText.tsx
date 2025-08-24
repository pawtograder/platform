export function termToTermText(term: number): string {
  let year = Math.floor(term / 100);
  const termCode = term % 100;
  const termMap: Record<number, string> = {
    10: "Fall",
    30: "Spring",
    40: "Summer 1",
    50: "Summer Full",
    60: "Summer 2"
  };
  if (termCode === 10) {
    //Apparently Banner made the brilliant decision that Fall is the next year so it sorts right.
    year = year - 1;
  }
  const name = termMap[termCode] ?? `Term ${termCode}`;
  return `${name} ${year}`;
}
export default function SemesterText({ semester }: { semester: number | null }) {
  if (!semester) {
    return <></>;
  }
  return termToTermText(semester);
}

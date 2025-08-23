export function termToTermText(term: number) {
  const year = Math.floor(term / 100);
  const termCode = term % 100;
  const termMap: { [key: number]: string } = {
    10: "Fall",
    20: "Spring",
    30: "Summer 1",
    40: "Summer 2"
  };

  return `${termMap[termCode]} ${year}`;
}
export default function SemesterText({ semester }: { semester: number | null }) {
  if (!semester) {
    return <></>;
  }
  return termToTermText(semester);
}

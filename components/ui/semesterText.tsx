export default function SemesterText({ semester }: { semester: number | null }) {
  if (!semester) {
    return <></>;
  }
  const semString = semester.toString();
  const year = semString.substring(0, 4);
  const semKey = semString.substring(4);
  let semKeyText = "";
  switch (semKey) {
    case "1":
      semKeyText = "Spring";
      break;
    case "2":
      semKeyText = "Summer";
      break;
    case "3":
      semKeyText = "Fall";
      break;
    default:
      semKeyText = "Unknown";
      break;
  }
  return (
    <>
      {semKeyText} {year}
    </>
  );
}

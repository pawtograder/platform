import { readFileSync } from "fs";
import path from "path";

const schema = JSON.parse(readFileSync(path.join(__dirname, "../../../public/RubricSchema.json"), "utf8"));
const checkData = schema.definitions.YmlRubricChecksType.properties.data;

describe("RubricSchema.json — check data", () => {
  it("allows data with only exam_question_id", () => {
    expect(checkData.properties.exam_question_id).toEqual({ type: "number" });
    expect(checkData.required ?? []).not.toContain("options");
  });
});

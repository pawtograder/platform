import { readFileSync } from "fs";
import path from "path";

const schema = JSON.parse(readFileSync(path.join(__dirname, "../../../public/RubricSchema.json"), "utf8"));
const checkData = schema.definitions.YmlRubricChecksType.properties.data;

describe("RubricSchema.json — check data", () => {
  it("allows data with only exam_question_id", () => {
    expect(checkData.anyOf ?? [checkData]).toContainEqual(
      expect.objectContaining({
        properties: { exam_question_id: { type: "number" } },
        required: ["exam_question_id"]
      })
    );
  });
});

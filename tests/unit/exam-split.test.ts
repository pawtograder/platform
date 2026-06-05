/**
 * @jest-environment node
 */

import { examCount, groupByExam } from "../../lib/exam/split";

describe("groupByExam", () => {
  it("splits a flat page list into per-exam groups", () => {
    const pages = [0, 1, 2, 3, 4, 5];
    expect(groupByExam(pages, 2)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5]
    ]);
  });
  it("leaves a short final group when pages don't divide evenly", () => {
    expect(groupByExam([0, 1, 2], 2)).toEqual([[0, 1], [2]]);
  });
  it("treats pages_per_exam < 1 as 1", () => {
    expect(groupByExam([0, 1], 0)).toEqual([[0], [1]]);
  });
});

describe("examCount", () => {
  it("counts complete + partial exams", () => {
    expect(examCount(6, 2)).toBe(3);
    expect(examCount(5, 2)).toBe(3);
    expect(examCount(0, 2)).toBe(0);
  });
});

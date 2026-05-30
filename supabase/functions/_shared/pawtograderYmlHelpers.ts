import { GradedUnit, MutationTestUnit, PawtograderConfig, RegularTestUnit } from "./PawtograderYml.d.ts";

export function isMutationTestUnit(unit: GradedUnit): unit is MutationTestUnit {
  return "locations" in unit;
}

export function isRegularTestUnit(unit: GradedUnit): unit is RegularTestUnit {
  return "tests" in unit && "testCount" in unit;
}

export function getMutationUnitPoints(unit: MutationTestUnit): number {
  if (unit.linearScoring?.points != null) {
    return unit.linearScoring.points;
  }
  return unit.breakPoints?.[0]?.pointsToAward ?? 0;
}

export function getGradedUnitPoints(unit: GradedUnit): number {
  if (isMutationTestUnit(unit)) {
    return getMutationUnitPoints(unit);
  }
  if ("points" in unit && typeof unit.points === "number") {
    return unit.points;
  }
  return 0;
}

export function calculateTotalAutograderPoints(config: PawtograderConfig): number {
  const gradedParts = config.gradedParts ?? [];
  return gradedParts.reduce(
    (acc, part) => acc + (part.gradedUnits ?? []).reduce((unitAcc, unit) => unitAcc + getGradedUnitPoints(unit), 0),
    0
  );
}

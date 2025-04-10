
// Build configuration types
export interface BuildConfig {
    preset: 'java-gradle'
    cmd: string
    artifacts: string[]
    linter: {
      preset: 'checkstyle'
      policy: 'fail' | 'warn' | 'ignore'
    }
  }
  
  // Mutation testing types
  export interface BreakPoint {
    minimumMutantsDetected: number
    pointsToAward: number
  }
  
  export interface MutationTestUnit {
    name: string
    locations: string[] // format: "file:line-line"
    breakPoints: BreakPoint[]
  }
  
  // Regular test unit types
  export interface RegularTestUnit {
    name: string
    tests: string | string[] // format: "[T#.#]"
    points: number
    testCount: number
  }
  
  // Combined graded unit type
  export type GradedUnit = MutationTestUnit | RegularTestUnit
  
  // Graded part type
  export interface GradedPart {
    name: string
    gradedUnits: GradedUnit[]
  }
  
  // Main configuration type
  export interface PawtograderConfig {
    build: BuildConfig
    gradedParts: GradedPart[]
    submissionFiles: {
      files: string[]
      testFiles: string[]
    }
  }
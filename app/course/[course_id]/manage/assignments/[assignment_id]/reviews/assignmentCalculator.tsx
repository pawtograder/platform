import { SubmissionWithGrading, UserRoleWithConflictsAndName } from "./page";

interface FlowEdge {
  to: string;
  capacity: number;
  flow: number;
}

interface ResidualEdge {
  to: string;
  capacity: number;
  isReverse: boolean;
  originalEdge: FlowEdge;
}

interface PathNode {
  node: string;
  path: ResidualEdge[];
}

export interface AssignmentResult {
  success: boolean;
  error?: string;
  assignments: Map<UserRoleWithConflictsAndName, SubmissionWithGrading[]> | null;
  minAssignments?: number;
  maxAssignments?: number;
  totalFlow?: number;
  taCapacities?: Map<string, number>;
}

class NetworkFlow {
  residualGraph: Map<string, ResidualEdge[]>;
  graph: Map<string, FlowEdge[]>;

  constructor() {
    this.graph = new Map<string, FlowEdge[]>();
    this.residualGraph = new Map<string, ResidualEdge[]>();
  }

  addEdge(from: string, to: string, capacity: number): void {
    if (!this.graph.has(from)) this.graph.set(from, []);
    if (!this.graph.has(to)) this.graph.set(to, []);

    this.graph.get(from)!.push({ to, capacity, flow: 0 });
    this.graph.get(to)!.push({ to: from, capacity: 0, flow: 0 }); // reverse edge
  }

  buildResidualGraph(): void {
    this.residualGraph.clear();

    for (const [node, edges] of this.graph) {
      if (!this.residualGraph.has(node)) this.residualGraph.set(node, []);

      for (const edge of edges) {
        // Forward edge: remaining capacity
        if (edge.capacity - edge.flow > 0) {
          this.residualGraph.get(node)!.push({
            to: edge.to,
            capacity: edge.capacity - edge.flow,
            isReverse: false,
            originalEdge: edge
          });
        }

        // Backward edge: current flow
        if (edge.flow > 0) {
          if (!this.residualGraph.has(edge.to)) this.residualGraph.set(edge.to, []);
          this.residualGraph.get(edge.to)!.push({
            to: node,
            capacity: edge.flow,
            isReverse: true,
            originalEdge: edge
          });
        }
      }
    }
  }

  bfs(source: string, sink: string): ResidualEdge[] | null {
    const visited = new Set<string>();
    const queue: PathNode[] = [{ node: source, path: [] }];
    visited.add(source);

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      if (node === sink) {
        return path;
      }

      if (this.residualGraph.has(node)) {
        for (const edge of this.residualGraph.get(node)!) {
          if (!visited.has(edge.to)) {
            visited.add(edge.to);
            queue.push({
              node: edge.to,
              path: [...path, edge]
            });
          }
        }
      }
    }

    return null;
  }

  maxFlow(source: string, sink: string): number {
    let totalFlow = 0;

    while (true) {
      this.buildResidualGraph();
      const path = this.bfs(source, sink);

      if (!path) break;

      // Find bottleneck capacity
      const pathFlow = Math.min(...path.map((edge) => edge.capacity));

      // Update flows
      for (const edge of path) {
        if (edge.isReverse) {
          edge.originalEdge.flow -= pathFlow;
        } else {
          edge.originalEdge.flow += pathFlow;
        }
      }

      totalFlow += pathFlow;
    }

    return totalFlow;
  }
}

export class TAAssignmentSolver {
  tas: UserRoleWithConflictsAndName[];
  submissions: SubmissionWithGrading[];
  flow: NetworkFlow;
  source: string;
  sink: string;
  taPrefix: string;
  studentPrefix: string;
  minAssignments: number;
  maxAssignments: number;
  historicalWorkload: Map<string, number>;
  workloadReductionFactor: number;
  taCapacities: Map<string, number>;
  graderPreferences: Map<string, string>;

  constructor(
    tas: UserRoleWithConflictsAndName[],
    submissions: SubmissionWithGrading[],
    historicalWorkload: Map<string, number> = new Map(),
    graderPreferences: Map<string, string> = new Map(),
    workloadReductionFactor: number = 1 // reduced gradually if this makes assignment impossible
  ) {
    this.tas = tas;
    this.submissions = submissions;
    this.flow = new NetworkFlow();
    this.historicalWorkload = historicalWorkload;
    this.workloadReductionFactor = workloadReductionFactor;
    this.taCapacities = new Map();
    this.graderPreferences = graderPreferences;

    this.source = "SOURCE";
    this.sink = "SINK";
    this.taPrefix = "TA_";
    this.studentPrefix = "STUDENT_";

    this.minAssignments = Math.floor(submissions.length / tas.length);
    this.maxAssignments = Math.ceil(submissions.length / tas.length);
  }

  hasConflict(ta: UserRoleWithConflictsAndName, submission: SubmissionWithGrading): boolean {
    return !!ta.profiles?.grading_conflicts.find((conflict) => {
      return (
        conflict.student_profile_id === submission.profile_id ||
        submission.assignment_groups?.assignment_groups_members
          .map((member) => {
            return member.profile_id;
          })
          .includes(conflict.student_profile_id)
      );
    });
  }

  calculateTACapacity(taId: string): number {
    const historicalCount = this.historicalWorkload.get(taId) || 0;
    const reduction = Math.floor(historicalCount * this.workloadReductionFactor);
    const adjustedCapacity = this.maxAssignments - reduction;

    // Ensure minimum capacity of 1 and maximum of original maxAssignments
    return Math.max(1, Math.min(adjustedCapacity, this.maxAssignments));
  }

  /**
   * Validates that based on the number of submissions to grade is >= sum of the max amount each grader can grade.
   * Due to the nature of the maxAssignments calculation, this should always pass when workloadReductionFactor = 0.
   * EFFECT: reductions can cause issues so in case of insufficient support, we gradually decrease workload factor.
   */
  validateCapacityConstraints(): { isValid: boolean; error?: string } {
    let success = false;
    while (!success) {
      let totalCapacity = 0;
      for (const ta of this.tas) {
        const capacity = this.calculateTACapacity(ta.private_profile_id);
        this.taCapacities.set(ta.private_profile_id, capacity);
        totalCapacity += capacity;
      }
      if (totalCapacity < this.submissions.length) {
        this.workloadReductionFactor -= 0.1;
      } else {
        success = true;
      }
    }
    if (this.workloadReductionFactor < 0) {
      return {
        isValid: false,
        error: "Negative workload factor was needed in matching algorithm.  Check calculation of max assignments"
      };
    }

    return { isValid: true };
  }

  buildNetwork(): void {
    // Layer 1: Source to TAs (with adjusted capacity based on historical workload)
    for (const ta of this.tas) {
      const taNode = this.taPrefix + ta.private_profile_id;
      const capacity = this.calculateTACapacity(ta.private_profile_id);
      this.taCapacities.set(ta.private_profile_id, capacity);
      this.flow.addEdge(this.source, taNode, capacity);
    }

    // Layer 2: TAs to Students (capacity 1, only if no conflict)
    for (const ta of this.tas) {
      const taNode = this.taPrefix + ta.private_profile_id;
      for (const submission of this.submissions) {
        const studentNode = this.studentPrefix + submission.id;
        if (!this.hasConflict(ta, submission)) {
          this.flow.addEdge(taNode, studentNode, 1);
        }
      }
    }

    // Layer 3: Students to Sink (capacity 1 - each student needs exactly 1 TA)
    for (const submission of this.submissions) {
      const studentNode = this.studentPrefix + submission.id;
      this.flow.addEdge(studentNode, this.sink, 1);
    }
  }

  solve(): AssignmentResult {
    // Validate capacity constraints before building network
    const validation = this.validateCapacityConstraints();
    if (!validation.isValid) {
      return {
        success: false,
        assignments: null,
        taCapacities: this.taCapacities
      };
    }

    // Phase 1: Try to satisfy as many preferences as possible
    const preferenceResult = this.solveWithPreferences();

    // Phase 2: Complete the assignment with remaining students and available TA capacity
    const finalResult = this.completeAssignment(preferenceResult);

    return finalResult;
  }

  solveWithPreferences(): {
    assignedSubmissions: Set<number>;
    taAssignments: Map<UserRoleWithConflictsAndName, SubmissionWithGrading[]>;
    remainingCapacity: Map<string, number>;
  } {
    const assignedSubmissions = new Set<number>();
    const taAssignments = new Map<UserRoleWithConflictsAndName, SubmissionWithGrading[]>();
    const remainingCapacity = new Map<string, number>();

    // Initialize assignments and remaining capacity
    for (const ta of this.tas) {
      taAssignments.set(ta, []);
      remainingCapacity.set(ta.private_profile_id, this.taCapacities.get(ta.private_profile_id)!);
    }

    // Try to assign students to their preferred graders
    for (const submission of this.submissions) {
      if (!submission.profile_id) continue;

      const preferredGraderId = this.graderPreferences.get(submission.profile_id);

      if (preferredGraderId) {
        const preferredTA = this.tas.find((ta) => ta.private_profile_id === preferredGraderId);

        if (
          preferredTA &&
          !this.hasConflict(preferredTA, submission) &&
          remainingCapacity.get(preferredGraderId)! > 0
        ) {
          // Assign this submission to the preferred TA
          taAssignments.get(preferredTA)!.push(submission);
          assignedSubmissions.add(submission.id);
          remainingCapacity.set(preferredGraderId, remainingCapacity.get(preferredGraderId)! - 1);
        }
      }
    }

    return { assignedSubmissions, taAssignments, remainingCapacity };
  }

  completeAssignment(preferenceResult: {
    assignedSubmissions: Set<number>;
    taAssignments: Map<UserRoleWithConflictsAndName, SubmissionWithGrading[]>;
    remainingCapacity: Map<string, number>;
  }): AssignmentResult {
    const { assignedSubmissions, taAssignments, remainingCapacity } = preferenceResult;

    // Get unassigned submissions
    const unassignedSubmissions = this.submissions.filter((s) => !assignedSubmissions.has(s.id));

    if (unassignedSubmissions.length === 0) {
      // All submissions were assigned via preferences!
      const isBalanced = this.verifyBalance(taAssignments);
      return {
        success: isBalanced,
        assignments: taAssignments,
        minAssignments: this.minAssignments,
        maxAssignments: this.maxAssignments,
        totalFlow: this.submissions.length,
        taCapacities: this.taCapacities
      };
    }

    // TWO-PHASE APPROACH to ensure balanced assignment:
    // Phase 1: Assign minAssignments to each TA (ensures everyone gets work)
    // Phase 2: Assign remaining submissions to TAs who can handle more

    // Calculate how many each TA still needs to reach minAssignments
    const minNeeded = new Map<string, number>();
    for (const ta of this.tas) {
      const currentCount = taAssignments.get(ta)?.length || 0;
      const needed = Math.max(0, this.minAssignments - currentCount);
      minNeeded.set(ta.private_profile_id, needed);
    }

    let currentUnassigned = [...unassignedSubmissions];
    const currentAssigned = new Set(assignedSubmissions);

    // Phase 1: Use max flow to ensure everyone gets at least minAssignments
    const totalMinNeeded = Array.from(minNeeded.values()).reduce((a, b) => a + b, 0);

    // Early check: mathematically impossible if we need more assignments than we have submissions
    if (totalMinNeeded > 0 && currentUnassigned.length < totalMinNeeded) {
      return {
        success: false,
        error: `Not enough submissions to ensure minimum assignments for all graders. Need ${totalMinNeeded} assignments but only ${currentUnassigned.length} submissions available.`,
        assignments: null,
        taCapacities: this.taCapacities
      };
    }

    if (totalMinNeeded > 0) {
      this.flow = new NetworkFlow();

      // Layer 1: Source to TAs (with capacity = minNeeded)
      for (const ta of this.tas) {
        const taNode = this.taPrefix + ta.private_profile_id;
        const capacity = minNeeded.get(ta.private_profile_id)!;
        if (capacity > 0) {
          this.flow.addEdge(this.source, taNode, capacity);
        }
      }

      // Layer 2: TAs to unassigned students (capacity 1, only if no conflict)
      for (const ta of this.tas) {
        const taNode = this.taPrefix + ta.private_profile_id;
        for (const submission of currentUnassigned) {
          const studentNode = this.studentPrefix + submission.id;
          if (!this.hasConflict(ta, submission)) {
            this.flow.addEdge(taNode, studentNode, 1);
          }
        }
      }

      // Layer 3: Unassigned students to Sink (capacity 1)
      for (const submission of currentUnassigned) {
        const studentNode = this.studentPrefix + submission.id;
        this.flow.addEdge(studentNode, this.sink, 1);
      }

      const phase1Flow = this.flow.maxFlow(this.source, this.sink);

      if (phase1Flow < totalMinNeeded) {
        return {
          success: false,
          error: `Cannot ensure minimum assignments for all graders. Needed ${totalMinNeeded}, achieved ${phase1Flow}. This may be due to grading conflicts.`,
          assignments: null,
          taCapacities: this.taCapacities
        };
      }

      // Extract phase 1 assignments and merge
      const phase1Assignments = this.extractAssignments();
      for (const [ta, submissions] of phase1Assignments) {
        const existing = taAssignments.get(ta) || [];
        taAssignments.set(ta, [...existing, ...submissions]);
        for (const sub of submissions) {
          currentAssigned.add(sub.id);
        }
      }

      // Update unassigned list and remaining capacity
      currentUnassigned = this.submissions.filter((s) => !currentAssigned.has(s.id));
      for (const ta of this.tas) {
        const assigned = phase1Assignments.get(ta)?.length || 0;
        const current = remainingCapacity.get(ta.private_profile_id)!;
        remainingCapacity.set(ta.private_profile_id, current - assigned);
      }
    }

    // Phase 2: Assign any remaining submissions
    if (currentUnassigned.length > 0) {
      this.flow = new NetworkFlow();

      // Layer 1: Source to TAs (with remaining capacity)
      for (const ta of this.tas) {
        const taNode = this.taPrefix + ta.private_profile_id;
        const capacity = remainingCapacity.get(ta.private_profile_id)!;
        if (capacity > 0) {
          this.flow.addEdge(this.source, taNode, capacity);
        }
      }

      // Layer 2: TAs to unassigned students (capacity 1, only if no conflict)
      for (const ta of this.tas) {
        const taNode = this.taPrefix + ta.private_profile_id;
        for (const submission of currentUnassigned) {
          const studentNode = this.studentPrefix + submission.id;
          if (!this.hasConflict(ta, submission)) {
            this.flow.addEdge(taNode, studentNode, 1);
          }
        }
      }

      // Layer 3: Unassigned students to Sink (capacity 1)
      for (const submission of currentUnassigned) {
        const studentNode = this.studentPrefix + submission.id;
        this.flow.addEdge(studentNode, this.sink, 1);
      }

      const phase2Flow = this.flow.maxFlow(this.source, this.sink);

      if (phase2Flow < currentUnassigned.length) {
        return {
          success: false,
          error: `Cannot assign all remaining students. Missing assignments: ${currentUnassigned.length - phase2Flow}`,
          assignments: null,
          taCapacities: this.taCapacities
        };
      }

      // Extract phase 2 assignments and merge
      const phase2Assignments = this.extractAssignments();
      for (const [ta, submissions] of phase2Assignments) {
        const existing = taAssignments.get(ta) || [];
        taAssignments.set(ta, [...existing, ...submissions]);
      }
    }

    const isBalanced = this.verifyBalance(taAssignments);

    return {
      success: isBalanced,
      assignments: taAssignments,
      minAssignments: this.minAssignments,
      maxAssignments: this.maxAssignments,
      totalFlow: this.submissions.length,
      taCapacities: this.taCapacities
    };
  }

  extractAssignments(): Map<UserRoleWithConflictsAndName, SubmissionWithGrading[]> {
    const assignments = new Map<UserRoleWithConflictsAndName, SubmissionWithGrading[]>();

    // Initialize assignment map
    for (const ta of this.tas) {
      assignments.set(ta, []);
    }

    // Extract from flow graph
    for (const [node, edges] of this.flow.graph) {
      if (node.startsWith(this.taPrefix)) {
        const taId = node.substring(this.taPrefix.length);
        const ta = this.tas.find((t) => t.private_profile_id === taId);

        if (ta) {
          for (const edge of edges) {
            if (edge.to.startsWith(this.studentPrefix) && edge.flow > 0) {
              const submissionId = edge.to.substring(this.studentPrefix.length);
              const submission = this.submissions.find((s) => s.id.toString() === submissionId);

              if (submission) {
                assignments.get(ta)!.push(submission);
              }
            }
          }
        }
      }
    }

    return assignments;
  }

  verifyBalance(assignments: Map<UserRoleWithConflictsAndName, SubmissionWithGrading[]>): boolean {
    for (const [ta, students] of assignments) {
      const count = students.length;
      const expectedCapacity = this.taCapacities.get(ta.private_profile_id) || this.maxAssignments;

      // For TAs with reduced capacity, we expect them to be at or near their capacity
      // For TAs with normal capacity, we use the original min/max range
      const minExpected = Math.min(this.minAssignments, expectedCapacity);
      const maxExpected = expectedCapacity;

      if (count < minExpected || count > maxExpected) {
        console.warn(
          `TA ${ta.private_profile_id} has ${count} assignments (expected ${minExpected}-${maxExpected}, capacity: ${expectedCapacity})`
        );
        return false;
      }
    }
    return true;
  }
}

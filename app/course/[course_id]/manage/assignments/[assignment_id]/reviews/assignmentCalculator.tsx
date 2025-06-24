import { SubmissionWithGrading, UserRoleWithConflicts } from "./page";

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
  assignments: Map<UserRoleWithConflicts, SubmissionWithGrading[]> | null;
  minAssignments?: number;
  maxAssignments?: number;
  totalFlow?: number;
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
  tas: UserRoleWithConflicts[];
  submissions: SubmissionWithGrading[];
  flow: NetworkFlow;
  source: string;
  sink: string;
  taPrefix: string;
  studentPrefix: string;
  minAssignments: number;
  maxAssignments: number;

  constructor(tas: UserRoleWithConflicts[], submissions: SubmissionWithGrading[]) {
    this.tas = tas;
    this.submissions = submissions;
    this.flow = new NetworkFlow();

    this.source = "SOURCE";
    this.sink = "SINK";
    this.taPrefix = "TA_";
    this.studentPrefix = "STUDENT_";

    this.minAssignments = Math.floor(submissions.length / tas.length);
    this.maxAssignments = Math.ceil(submissions.length / tas.length);
  }

  hasConflict(ta: UserRoleWithConflicts, submission: SubmissionWithGrading): boolean {
    return ta.profiles?.grading_conflicts.find((conflict) => {
      return conflict.student_profile_id === submission.profile_id; // add group handling here
    })
      ? true
      : false;
  }

  buildNetwork(): void {
    // Layer 1: Source to TAs (infinite capacity)
    for (const ta of this.tas) {
      const taNode = this.taPrefix + ta.private_profile_id;
      this.flow.addEdge(this.source, taNode, Number.MAX_SAFE_INTEGER);
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

    // Layer 3: Students to Sink (infinite capacity)
    for (const submission of this.submissions) {
      const studentNode = this.studentPrefix + submission.id;
      this.flow.addEdge(studentNode, this.sink, Number.MAX_SAFE_INTEGER);
    }
  }

  solve(): AssignmentResult {
    this.buildNetwork();

    // First, find maximum possible assignment
    const maxPossibleFlow = this.flow.maxFlow(this.source, this.sink);

    if (maxPossibleFlow < this.submissions.length) {
      return {
        success: false,
        error: `Cannot assign all students. Maximum possible assignments: ${maxPossibleFlow}`,
        assignments: null
      };
    }

    // Now we need to ensure balanced assignment
    // We'll use a modified approach with capacity constraints on TAs
    this.flow = new NetworkFlow(); // Reset

    // Rebuild with TA capacity constraints
    for (const ta of this.tas) {
      const taNode = this.taPrefix + ta.private_profile_id;
      this.flow.addEdge(this.source, taNode, this.maxAssignments);
    }

    for (const ta of this.tas) {
      const taNode = this.taPrefix + ta.private_profile_id;
      for (const submission of this.submissions) {
        const studentNode = this.studentPrefix + submission.id;
        if (!this.hasConflict(ta, submission)) {
          this.flow.addEdge(taNode, studentNode, 1);
        }
      }
    }

    for (const submission of this.submissions) {
      const studentNode = this.studentPrefix + submission.id;
      this.flow.addEdge(studentNode, this.sink, 1); // Each student needs exactly 1 TA
    }

    const finalFlow = this.flow.maxFlow(this.source, this.sink);

    if (finalFlow < this.submissions.length) {
      return {
        success: false,
        error: `Cannot create balanced assignment. Achieved flow: ${finalFlow}`,
        assignments: null
      };
    }

    // Extract assignments from the flow
    const assignments = this.extractAssignments();

    // Verify balance constraints
    const isBalanced = this.verifyBalance(assignments);

    return {
      success: isBalanced,
      assignments: assignments,
      minAssignments: this.minAssignments,
      maxAssignments: this.maxAssignments,
      totalFlow: finalFlow
    };
  }

  extractAssignments(): Map<UserRoleWithConflicts, SubmissionWithGrading[]> {
    const assignments = new Map<UserRoleWithConflicts, SubmissionWithGrading[]>();

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

  verifyBalance(assignments: Map<UserRoleWithConflicts, SubmissionWithGrading[]>): boolean {
    for (const [ta, students] of assignments) {
      const count = students.length;
      if (count < this.minAssignments || count > this.maxAssignments) {
        console.warn(
          `TA ${ta.private_profile_id} has ${count} assignments (expected ${this.minAssignments}-${this.maxAssignments})`
        );
        return false;
      }
    }
    return true;
  }
}

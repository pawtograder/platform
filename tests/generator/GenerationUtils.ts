// ============================
// RATE LIMITING AND PERFORMANCE TRACKING
// ============================
import { UnstableGetResult as GetResult, PostgrestTransformBuilder } from "@supabase/postgrest-js";

import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { PostgrestError, UserResponse } from "@supabase/supabase-js";
import Bottleneck from "bottleneck";
import { supabase } from "../e2e/TestingUtils";

// ============================
// RATE LIMITING CONFIGURATION
// ============================

export interface RateLimitConfig {
  maxInsertsPerSecond: number;
  description: string;
  batchSize?: number; // Optional batch size for operations that insert in batches
}

export const MAX_DB_OPS_PER_SECOND = 100;
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  // User management operations (auth-sensitive)
  users: { maxInsertsPerSecond: 5, description: "User creation (auth operations)" },
  profiles: { maxInsertsPerSecond: 100, description: "Profile creation" },
  user_roles: { maxInsertsPerSecond: 50, description: "User role assignments" },

  // Assignment and rubric operations
  assignments: { maxInsertsPerSecond: 5, description: "Assignment creation" },
  rubric_parts: { maxInsertsPerSecond: 30, description: "Rubric parts" },
  rubric_criteria: { maxInsertsPerSecond: 30, description: "Rubric criteria" },
  rubric_checks: { maxInsertsPerSecond: 30, description: "Rubric checks" },

  // Submission operations (high volume, batched, batch count is on submissions, but all follows that batch!)
  repositories: { maxInsertsPerSecond: 20, description: "Repository records" },
  repository_check_runs: { maxInsertsPerSecond: 20, description: "Repository check runs" },
  submissions: { maxInsertsPerSecond: 20, description: "Submission records", batchSize: 20 },
  submission_files: { maxInsertsPerSecond: 20, description: "Submission files" },

  // Grading operations (moderate volume, batched)
  grader_results: { maxInsertsPerSecond: 60, description: "Grader results" },
  grader_result_tests: { maxInsertsPerSecond: 100, description: "Grader result tests" },
  submission_reviews: { maxInsertsPerSecond: 40, description: "Submission reviews" },
  submission_comments: { maxInsertsPerSecond: 10, description: "Submission comments", batchSize: 200 },
  submission_file_comments: { maxInsertsPerSecond: 10, description: "Submission file comments", batchSize: 200 },

  // Gradebook operations
  gradebook_columns: { maxInsertsPerSecond: 1, description: "Gradebook columns" },
  gradebook_column_students: { maxInsertsPerSecond: 50, description: "Gradebook column student records" },

  // Class structure operations (some batched)
  class_sections: { maxInsertsPerSecond: 20, description: "Class sections" },
  lab_sections: { maxInsertsPerSecond: 20, description: "Lab sections" },
  assignment_groups: { maxInsertsPerSecond: 30, description: "Assignment groups" },
  assignment_groups_members: { maxInsertsPerSecond: 500, description: "Assignment group members" },

  // Communication operations (some batched)
  help_requests: { maxInsertsPerSecond: 15, description: "Help requests" },
  help_request_messages: { maxInsertsPerSecond: 40, description: "Help request messages" },
  help_request_students: { maxInsertsPerSecond: 100, description: "Help request student associations" },
  discussion_threads: { maxInsertsPerSecond: 1, description: "Discussion threads", batchSize: 10 },

  // Metadata operations (some batched)
  tags: { maxInsertsPerSecond: 30, description: "Tag assignments" },
  grading_conflicts: { maxInsertsPerSecond: 300, description: "Grading conflicts" },
  workflow_events: { maxInsertsPerSecond: 100, description: "Workflow events", batchSize: 100 },
  workflow_run_error: { maxInsertsPerSecond: 100, description: "Workflow errors", batchSize: 100 },

  // Miscellaneous operations
  assignment_due_date_exceptions: { maxInsertsPerSecond: 200, description: "Due date exceptions" },
  submission_regrade_requests: { maxInsertsPerSecond: 50, description: "Regrade requests" }
};
// Performance tracking
export interface PerformanceMetrics {
  totalInserted: number;
  startTime: number;
  endTime?: number;
  actualRate?: number;
  operations: Array<{
    timestamp: number;
    count: number;
  }>;
}

type DatabaseTableTypes = Database["public"]["Tables"];

export class RateLimitManager {
  private rateLimiters: Record<string, Bottleneck> = {};
  private globalLimiter!: Bottleneck;
  private performanceTracker: Record<string, PerformanceMetrics> = {};
  private progressTracker: Record<string, { totalProcessed: number; lastUpdate: number; progressBar: string }> = {};
  readonly batchSizes: Record<string, number> = {};

  constructor(rateLimits: Record<string, RateLimitConfig>, maxDbOpsPerSecond: number = MAX_DB_OPS_PER_SECOND) {
    this.initializeGlobalLimiter(maxDbOpsPerSecond);
    this.initializeRateLimiters(rateLimits);
    this.initializePerformanceTracking(rateLimits);
    this.initializeProgressTracking(rateLimits);
    this.initializeBatchSizes(rateLimits);
  }

  private initializeGlobalLimiter(maxDbOpsPerSecond: number) {
    this.globalLimiter = new Bottleneck({
      maxConcurrent: Math.max(1, Math.floor(maxDbOpsPerSecond / 2)), // Conservative concurrency
      minTime: Math.ceil(1000 / maxDbOpsPerSecond) // Minimum time between any database operations
    });
  }

  private initializeBatchSizes(rateLimits: Record<string, RateLimitConfig>) {
    Object.entries(rateLimits).forEach(([dataType, config]) => {
      this.batchSizes[dataType] = config.batchSize ?? 1;
    });
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 5,
    baseDelayMs: number = 5000
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        if (typeof result === "object" && result && "error" in result && result.error) {
          throw result.error;
        }
        return result;
      } catch (error) {
        lastError = error as Error;

        if (attempt === maxRetries) {
          // Final attempt failed, throw the error
          throw lastError;
        }

        // Calculate exponential backoff delay with jitter: baseDelay * 2^attempt
        const exponentialDelayMs = baseDelayMs * Math.pow(2, attempt);
        // Add equal jitter: half base delay + random half to reduce herding
        const delayMs = exponentialDelayMs / 2 + Math.random() * (exponentialDelayMs / 2);
        console.warn(
          `⚠️ Operation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs / 1000}s: ${lastError.message}`
        );

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError!;
  }

  private initializeRateLimiters(rateLimits: Record<string, RateLimitConfig>) {
    Object.entries(rateLimits).forEach(([dataType, config]) => {
      // Use the configured rate directly, regardless of batch size
      // Batch size only affects how many items are processed together, not the rate limit
      const effectiveRatePerSecond = config.maxInsertsPerSecond;
      const effectiveConcurrency = Math.max(1, Math.floor(config.maxInsertsPerSecond / 2));

      this.rateLimiters[dataType] = new Bottleneck({
        maxConcurrent: effectiveConcurrency,
        minTime: Math.ceil(1000 / effectiveRatePerSecond) // Minimum time between operations
      });
    });
  }

  private initializePerformanceTracking(rateLimits: Record<string, RateLimitConfig>) {
    Object.keys(rateLimits).forEach((dataType) => {
      this.performanceTracker[dataType] = {
        totalInserted: 0,
        startTime: Date.now(),
        operations: []
      };
    });
  }

  private initializeProgressTracking(rateLimits: Record<string, RateLimitConfig>) {
    Object.keys(rateLimits).forEach((dataType) => {
      this.progressTracker[dataType] = {
        totalProcessed: 0,
        lastUpdate: 0,
        progressBar: ""
      };
    });
  }

  async trackAndLimit<
    T extends keyof DatabaseTableTypes,
    Query extends string = "*",
    ResultType = GetResult<
      Database["public"],
      Database["public"]["Tables"][T]["Row"],
      T,
      Database["public"]["Tables"][T]["Relationships"],
      Query
    >
  >(
    dataType: T,
    operation: () => PostgrestTransformBuilder<
      Database["public"],
      Database["public"]["Tables"][T]["Row"],
      ResultType[],
      T,
      Database["public"]["Tables"][T]["Relationships"]
    >,
    count: number = 1
  ): Promise<{
    data: ResultType[];
    error: PostgrestError | null;
  }> {
    const limiter = this.rateLimiters[dataType];
    if (!limiter) {
      console.warn(`⚠️ No rate limiter configured for data type: ${dataType}`);
      return (await operation()) as unknown as {
        data: ResultType[];
        error: PostgrestError;
      };
    }

    const result = await this.executeWithRetry(async () => {
      return await this.globalLimiter.schedule(async () => {
        return await limiter.schedule(async () => {
          return await operation();
        });
      });
    });

    // Track performance
    const metrics = this.performanceTracker[dataType];
    metrics.totalInserted += count;
    metrics.operations.push({
      timestamp: Date.now(),
      count
    });

    // Update progress bar
    this.updateProgressBar(dataType, count);

    return result as unknown as {
      data: ResultType[];
      error: PostgrestError | null;
    };
  }
  async createUser({
    email,
    password,
    email_confirm
  }: {
    email: string;
    password: string;
    email_confirm: boolean;
  }): Promise<UserResponse> {
    const limiter = this.rateLimiters.users;
    if (!limiter) {
      console.warn(`⚠️ No rate limiter configured for data type: users`);
      return await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm
      });
    }

    const result = await this.executeWithRetry(async () => {
      return await this.globalLimiter.schedule(async () => {
        return await limiter.schedule(async () => {
          return await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm
          });
        });
      });
    });

    // Track performance
    const metrics = this.performanceTracker["users"];
    metrics.totalInserted += 1;
    metrics.operations.push({
      timestamp: Date.now(),
      count: 1
    });

    // Update progress bar
    this.updateProgressBar("users", 1);

    return result;
  }

  private updateProgressBar(dataType: string, count: number): void {
    const progress = this.progressTracker[dataType];
    const metrics = this.performanceTracker[dataType];

    progress.totalProcessed += count;

    // Update every 100 rows or more
    if (progress.totalProcessed - progress.lastUpdate >= 100) {
      const progressChars = Math.floor(progress.totalProcessed / 100);
      const newChars = progressChars - progress.progressBar.length;

      // Add new progress characters
      progress.progressBar += "█".repeat(newChars);

      // Calculate running average rate (operations per second)
      const elapsedSeconds = (Date.now() - metrics.startTime) / 1000;
      const avgRate = elapsedSeconds > 0 ? (progress.totalProcessed / elapsedSeconds).toFixed(1) : "0.0";

      // Format output in columns with resource name and rate
      const resourceDisplay = `${dataType} (${avgRate}/sec avg)`;
      const paddedResource = resourceDisplay.padEnd(35);

      // Split progress bar into rows of 50 characters for readability
      const charsPerRow = 50;
      const rows = Math.ceil(progress.progressBar.length / charsPerRow);

      if (rows === 1) {
        // Single row
        process.stdout.write(`\r${paddedResource} ${progress.progressBar} ${progress.totalProcessed}`);
      } else {
        // Multiple rows - clear and redraw
        process.stdout.write("\r\x1B[K"); // Clear current line
        console.log(`${paddedResource} ${progress.totalProcessed} rows`);

        for (let i = 0; i < rows; i++) {
          const start = i * charsPerRow;
          const end = Math.min(start + charsPerRow, progress.progressBar.length);
          const rowChars = progress.progressBar.slice(start, end);
          const rowPadding = " ".repeat(35); // Match resource display padding
          console.log(`${rowPadding} ${rowChars}`);
        }
        process.stdout.write("\x1B[0G"); // Move cursor to beginning of line
      }

      progress.lastUpdate = progress.totalProcessed;
    }
  }

  finalizeProgressBars(): void {
    Object.entries(this.progressTracker).forEach(([dataType, progress]) => {
      if (progress.totalProcessed > 0) {
        // Ensure final progress is displayed
        const metrics = this.performanceTracker[dataType];
        const elapsedSeconds = (Date.now() - metrics.startTime) / 1000;
        const avgRate = elapsedSeconds > 0 ? (progress.totalProcessed / elapsedSeconds).toFixed(1) : "0.0";

        const resourceDisplay = `${dataType} (${avgRate}/sec avg)`;
        const paddedResource = resourceDisplay.padEnd(35);

        // Complete the progress bar
        const finalProgressChars = Math.floor(progress.totalProcessed / 100);
        const finalBar = "█".repeat(finalProgressChars);

        console.log(`\r${paddedResource} ${finalBar} ${progress.totalProcessed} COMPLETED`);
      }
    });
  }

  finalizePerformanceTracking(): void {
    this.finalizeProgressBars();

    const now = Date.now();
    Object.entries(this.performanceTracker).forEach(([, metrics]) => {
      metrics.endTime = now;
      const durationSeconds = (now - metrics.startTime) / 1000;
      metrics.actualRate = metrics.totalInserted / durationSeconds;
    });
  }

  displayPerformanceSummary(rateLimits: Record<string, RateLimitConfig>): void {
    console.log("\n" + "=".repeat(80));
    console.log("📊 DATABASE INSERTION PERFORMANCE SUMMARY");
    console.log("=".repeat(80));

    // Calculate totals
    let totalInserted = 0;
    let totalDuration = 0;
    let activeDataTypes = 0;

    const sortedMetrics = Object.entries(this.performanceTracker)
      .filter(([, metrics]) => metrics.totalInserted > 0)
      .sort((a, b) => b[1].totalInserted - a[1].totalInserted);

    if (sortedMetrics.length === 0) {
      console.log("No data was inserted during this run.");
      return;
    }

    console.log(`\n🎯 RATE LIMITS CONFIGURATION:`);
    console.log(`Global DB Operations Limit: ${MAX_DB_OPS_PER_SECOND} ops/sec`);
    console.log("Data Type".padEnd(25) + "Max Rate/sec".padEnd(15) + "Batch Size".padEnd(12) + "Description");
    console.log("-".repeat(82));

    sortedMetrics.forEach(([dataType]) => {
      const config = rateLimits[dataType];
      const batchInfo = config.batchSize ? config.batchSize.toString() : "N/A";
      console.log(
        dataType.padEnd(25) +
          config.maxInsertsPerSecond.toString().padEnd(15) +
          batchInfo.padEnd(12) +
          config.description
      );
    });

    console.log(`\n📈 ACTUAL PERFORMANCE RESULTS:`);
    console.log(
      "Data Type".padEnd(25) +
        "Count".padEnd(12) +
        "Target/sec".padEnd(12) +
        "Actual/sec".padEnd(12) +
        "Batch Info".padEnd(15) +
        "Efficiency"
    );
    console.log("-".repeat(95));

    sortedMetrics.forEach(([dataType, metrics]) => {
      const config = rateLimits[dataType];
      const efficiency = ((metrics.actualRate || 0) / config.maxInsertsPerSecond) * 100;
      const efficiencyStr = `${efficiency.toFixed(1)}%`;

      let batchInfo = "Individual";
      if (config.batchSize) {
        batchInfo = `Batch size: ${config.batchSize}`;
      }

      console.log(
        dataType.padEnd(25) +
          metrics.totalInserted.toLocaleString().padEnd(12) +
          config.maxInsertsPerSecond.toString().padEnd(12) +
          (metrics.actualRate?.toFixed(2) || "0").padEnd(12) +
          batchInfo.padEnd(15) +
          efficiencyStr
      );

      totalInserted += metrics.totalInserted;
      totalDuration = Math.max(totalDuration, (metrics.endTime || Date.now()) - metrics.startTime);
      activeDataTypes++;
    });

    console.log("-".repeat(80));

    const overallRate = totalInserted / (totalDuration / 1000);
    const totalTargetRate = sortedMetrics.reduce(
      (sum, [dataType]) => sum + rateLimits[dataType].maxInsertsPerSecond,
      0
    );
    const overallEfficiency = (overallRate / totalTargetRate) * 100;

    console.log(
      "TOTALS".padEnd(25) +
        totalInserted.toLocaleString().padEnd(12) +
        totalTargetRate.toString().padEnd(12) +
        overallRate.toFixed(2).padEnd(12) +
        `${overallEfficiency.toFixed(1)}%`
    );

    console.log(`\n⏱️  TIMING SUMMARY:`);
    console.log(`   Total Duration: ${(totalDuration / 1000).toFixed(2)} seconds`);
    console.log(`   Total Records Inserted: ${totalInserted.toLocaleString()}`);
    console.log(`   Overall Insertion Rate: ${overallRate.toFixed(2)} records/second`);
    console.log(`   Global Rate Limit: ${MAX_DB_OPS_PER_SECOND} ops/sec (applied across all data types)`);
    console.log(`   Active Data Types: ${activeDataTypes}`);

    console.log("=".repeat(80));
  }
}

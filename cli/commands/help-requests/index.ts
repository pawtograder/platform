/**
 * Help Requests command group
 *
 * Usage:
 *   pawtograder help-requests list --class <identifier> [--status active] [--queue <id|name>] [--json]
 *   pawtograder help-requests close --id <id> [--status closed] [--resolution-status staff_helped] [--notes "..."]
 */

import type { Argv } from "yargs";
import { apiCall } from "@/cli/utils/api";
import { logger, handleError } from "@/cli/utils/logger";
import { addJsonOption, emitJson, printTable, truncate, formatDateTime } from "@/cli/utils/output";

export const command = "help-requests <action>";
export const describe = "Manage help requests";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List help requests for a class",
      (yargs) => {
        return addJsonOption(
          yargs
            .option("class", {
              alias: "c",
              describe: "Class ID, slug, or name",
              type: "string",
              demandOption: true
            })
            .option("status", {
              describe: "Filter by status ('active' means open or in_progress)",
              type: "string",
              choices: ["open", "in_progress", "resolved", "closed", "active", "all"],
              default: "all"
            })
            .option("queue", {
              describe: "Restrict to one help queue (ID or name)",
              type: "string"
            })
            .option("limit", {
              describe: "Maximum requests to return",
              type: "number",
              default: 100
            })
        );
      },
      async (args) => {
        try {
          const data = await apiCall("help_requests.list", {
            class: args.class as string,
            status: args.status as string,
            queue: args.queue as string | undefined,
            limit: args.limit as number
          });

          if (emitJson(args, data)) return;

          logger.step(`Help requests for ${data.class.name}`);

          const requests = data.requests ?? [];
          if (requests.length === 0) {
            logger.info("No help requests found.");
            return;
          }

          printTable(
            ["ID", "Queue", "Status", "Student", "Assignee", "Created", "Request"],
            requests.map((r: Record<string, unknown>) => [
              r.id as number,
              r.queue_name as string | null,
              r.status as string,
              (r.created_by_name as string | null) ?? null,
              (r.assignee_name as string | null) ?? null,
              formatDateTime(r.created_at as string | null),
              truncate(r.request as string | null, 50)
            ])
          );

          logger.blank();
          const byStatus = Object.entries(data.summary.by_status as Record<string, number>)
            .map(([status, count]) => `${status}: ${count}`)
            .join(", ");
          logger.info(`Total: ${data.summary.total} request(s)${byStatus ? ` (${byStatus})` : ""}`);
          if (data.summary.truncated) {
            logger.warning(`Output truncated at --limit ${args.limit}; pass a higher --limit for more.`);
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "close",
      "Close or resolve a help request",
      (yargs) => {
        return yargs
          .option("id", {
            describe: "Help request ID",
            type: "number",
            demandOption: true
          })
          .option("status", {
            describe: "Terminal status to set",
            type: "string",
            choices: ["closed", "resolved"],
            default: "closed"
          })
          .option("resolution-status", {
            describe: "How the request was resolved (drives the resolution system message)",
            type: "string",
            choices: ["self_solved", "staff_helped", "peer_helped", "no_time", "other"]
          })
          .option("notes", {
            describe: "Resolution notes to record on the request",
            type: "string"
          })
          .option("force", {
            describe: "Overwrite the resolution of an already resolved/closed request",
            type: "boolean",
            default: false
          });
      },
      async (args) => {
        try {
          const data = await apiCall("help_requests.close", {
            id: args.id as number,
            status: args.status as string,
            resolution_status: args.resolutionStatus as string | undefined,
            notes: args.notes as string | undefined,
            force: args.force as boolean
          });

          const request = data.request;
          logger.success(`Help request ${request.id}: ${data.previous_status} -> ${request.status}`);
          if (request.resolution_status) {
            logger.info(`Resolution: ${request.resolution_status}`);
          }
          if (request.resolution_notes) {
            logger.info(`Notes: ${request.resolution_notes}`);
          }

          if (data.video_still_live) {
            logger.blank();
            logger.warning(
              "This request had a live video call. Closing it does not end the meeting — " +
                "end the call from the office-hours page to tear down the Chime session."
            );
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};

import { Endpoints } from "@octokit/types";

export type ListReposResponse = Endpoints["GET /orgs/{org}/repos"]["response"]['data'];

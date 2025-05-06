import { Endpoints } from "@octokit/types";

export type ListReposResponse = Endpoints["GET /orgs/{org}/repos"]["response"]["data"];
export type ListFilesResponse = Endpoints["GET /repos/{owner}/{repo}/contents"]["response"]["data"];

/**
 * LTI 1.3 / LTI Advantage claim constants and TypeScript types.
 *
 * Spec references:
 *  - LTI 1.3 Core: https://www.imsglobal.org/spec/lti/v1p3
 *  - Names & Role Provisioning (NRPS): https://www.imsglobal.org/spec/lti-nrps/v2p0
 *  - Assignment & Grade Services (AGS): https://www.imsglobal.org/spec/lti-ags/v2p0
 */

// ---- Message type URNs ---------------------------------------------------
export const LTI_CLAIM = {
  messageType: "https://purl.imsglobal.org/spec/lti/claim/message_type",
  version: "https://purl.imsglobal.org/spec/lti/claim/version",
  deploymentId: "https://purl.imsglobal.org/spec/lti/claim/deployment_id",
  targetLinkUri: "https://purl.imsglobal.org/spec/lti/claim/target_link_uri",
  resourceLink: "https://purl.imsglobal.org/spec/lti/claim/resource_link",
  roles: "https://purl.imsglobal.org/spec/lti/claim/roles",
  context: "https://purl.imsglobal.org/spec/lti/claim/context",
  custom: "https://purl.imsglobal.org/spec/lti/claim/custom",
  lis: "https://purl.imsglobal.org/spec/lti/claim/lis",
  // Services
  nrps: "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice",
  ags: "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
  // Deep linking
  deepLinkingSettings: "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings",
  deepLinkingContentItems: "https://purl.imsglobal.org/spec/lti-dl/claim/content_items"
} as const;

export const LTI_MESSAGE_TYPE = {
  resourceLinkRequest: "LtiResourceLinkRequest",
  deepLinkingRequest: "LtiDeepLinkingRequest",
  deepLinkingResponse: "LtiDeepLinkingResponse"
} as const;

// ---- AGS scopes ----------------------------------------------------------
export const AGS_SCOPE = {
  lineItem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  lineItemReadonly: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  result: "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score"
} as const;

export const NRPS_SCOPE = "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";

// ---- LTI role URNs (the subset we map) -----------------------------------
export const LTI_ROLE = {
  instructor: "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
  teachingAssistant: "http://purl.imsglobal.org/vocab/lis/v2/membership#TeachingAssistant",
  contentDeveloper: "http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper",
  learner: "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
  // Short forms some platforms still emit:
  instructorShort: "Instructor",
  learnerShort: "Learner",
  taShort: "TeachingAssistant"
} as const;

export type AppRole = "instructor" | "grader" | "student";

/** Map LTI membership roles to a Pawtograder app_role (highest wins).
 *
 * Only CONTEXT-membership roles count — the `roles` claim can also carry
 * institution/system roles (e.g. `.../institution/person#Instructor` for any
 * faculty member), which must NOT grant instructor in a course where the user
 * is merely a Learner. So we match the bare short form or the full
 * context-membership URN exactly, never an arbitrary `#`-suffix. */
export function ltiRolesToAppRole(roles: string[] | undefined): AppRole {
  const MEMBERSHIP_NS = "http://purl.imsglobal.org/vocab/lis/v2/membership#";
  const has = (needle: string) => (roles ?? []).some((r) => r === needle || r === `${MEMBERSHIP_NS}${needle}`);
  if (has("Instructor")) return "instructor";
  if (has("TeachingAssistant") || has("ContentDeveloper")) return "grader";
  return "student";
}

// ---- Validated launch shape we hand to the app ---------------------------
export type LtiLaunchContext = {
  platformId: number;
  issuer: string;
  clientId: string;
  deploymentId: string;
  sub: string;
  name?: string;
  email?: string;
  lisPersonSourcedId?: string;
  roles: string[];
  appRole: AppRole;
  context?: { id: string; label?: string; title?: string };
  resourceLink?: { id: string; title?: string };
  targetLinkUri?: string;
  nrpsUrl?: string;
  ags?: { lineItemsUrl?: string; lineItemUrl?: string; scopes: string[] };
  custom?: Record<string, string>;
  rawClaims: Record<string, unknown>;
};

// ---- NRPS membership -----------------------------------------------------
export type NrpsMember = {
  status?: "Active" | "Inactive" | "Deleted";
  user_id: string;
  roles: string[];
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  lis_person_sourcedid?: string;
  // Per-member message claims (some platforms include custom + resource link)
  message?: Array<Record<string, unknown>>;
};

export type NrpsMembershipResponse = {
  id: string;
  context: { id: string; label?: string; title?: string };
  members: NrpsMember[];
};

// ---- AGS line item -------------------------------------------------------
export type AgsLineItem = {
  id?: string; // resource URL once created
  scoreMaximum: number;
  label: string;
  resourceId?: string;
  resourceLinkId?: string;
  tag?: string;
  startDateTime?: string;
  endDateTime?: string;
};

export type AgsScore = {
  userId: string;
  scoreGiven?: number;
  scoreMaximum?: number;
  comment?: string;
  timestamp: string; // ISO8601
  activityProgress: "Initialized" | "Started" | "InProgress" | "Submitted" | "Completed";
  gradingProgress: "FullyGraded" | "Pending" | "PendingManual" | "Failed" | "NotReady";
};

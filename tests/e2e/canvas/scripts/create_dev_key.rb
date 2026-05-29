# rails runner script: create + enable an LTI 1.3 Developer Key for Pawtograder.
#
# Uses Lti::CreateRegistrationService -- the canonical, version-current path the
# Canvas UI/API itself uses -- to create, in one transaction:
#   * an Lti::Registration
#   * a DeveloperKey (its global id is the LTI 1.3 `client_id`)
#   * an Lti::ToolConfiguration (redirect_uris / target_link_uri /
#     oidc_initiation_url / public_jwk_url / NRPS + AGS scopes)
# and binds it "on" so it is enabled for the root account.
#
# It then deploys the tool to the root account (creating a ContextExternalTool)
# so a `deployment_id` exists.
#
# Tool URLs come from env (defaults point at a Pawtograder dev instance on
# host.docker.internal:3000 -- override for your harness):
#   PG_TOOL_HOST           base URL of the Pawtograder tool (default http://host.docker.internal:3000)
#   PG_OIDC_LOGIN_URL      default $PG_TOOL_HOST/api/lti/login
#   PG_LAUNCH_URL          default $PG_TOOL_HOST/api/lti/launch
#   PG_JWKS_URL            default $PG_TOOL_HOST/api/lti/jwks
#   PG_KEY_NAME            developer key / registration name (default "Pawtograder")
#   CANVAS_LMS_ADMIN_EMAIL admin user that "creates" the registration
#
# Prints:
#   CLIENT_ID=<developer_key.global_id>
#   DEPLOYMENT_ID=<context_external_tool.deployment_id>

require "json"

host        = ENV.fetch("PG_TOOL_HOST", "http://host.docker.internal:3000")
login_url   = ENV.fetch("PG_OIDC_LOGIN_URL", "#{host}/api/lti/login")
launch_url  = ENV.fetch("PG_LAUNCH_URL", "#{host}/api/lti/launch")
jwks_url    = ENV.fetch("PG_JWKS_URL", "#{host}/api/lti/jwks")
key_name    = ENV.fetch("PG_KEY_NAME", "Pawtograder")
admin_email = ENV.fetch("CANVAS_LMS_ADMIN_EMAIL", "canvas@example.com")

# Canvas refuses to fetch an http public_jwk_url (CanvasHttp::InsecureUriError),
# so when the tool's public JWK is provided inline (PG_PUBLIC_JWK), embed it and
# skip the URL — Canvas then verifies our client assertions with no HTTP fetch.
public_jwk = ENV["PG_PUBLIC_JWK"].to_s.empty? ? nil : JSON.parse(ENV["PG_PUBLIC_JWK"])

account = Account.default
pseudonym = Pseudonym.active.by_unique_id(admin_email).first
abort("ERROR: no admin pseudonym for #{admin_email}; run bootstrap first") unless pseudonym
admin = pseudonym.user

scopes = [
  TokenScopes::LTI_NRPS_V2_SCOPE,             # NRPS - course membership
  TokenScopes::LTI_AGS_LINE_ITEM_SCOPE,       # AGS - line items
  TokenScopes::LTI_AGS_SCORE_SCOPE,           # AGS - scores
  TokenScopes::LTI_AGS_RESULT_READ_ONLY_SCOPE # AGS - read results (handy for verification)
]

configuration_params = {
  title: key_name,
  description: "Pawtograder LTI 1.3 tool (e2e)",
  target_link_uri: launch_url,
  oidc_initiation_url: login_url,
  **(public_jwk ? { public_jwk: public_jwk } : { public_jwk_url: jwks_url }),
  redirect_uris: [launch_url],
  # "public" so launches include the user's name + email — Pawtograder needs the
  # email to bridge the LTI identity to a Pawtograder session. (Canvas defaults
  # LTI tools to "anonymous", which omits both.)
  privacy_level: "public",
  scopes:,
  # At least the course_navigation placement so the tool can launch in a course.
  placements: [
    {
      "placement" => "course_navigation",
      "message_type" => "LtiResourceLinkRequest",
      "target_link_uri" => launch_url,
      "text" => key_name
    }
  ],
  launch_settings: {}
}

# Reuse an existing registration with this name if present (idempotent re-runs).
existing = Lti::Registration.active.where(account:, name: key_name).first

registration =
  if existing
    puts "INFO: reusing existing registration ##{existing.id}"
    existing
  else
    Lti::CreateRegistrationService.call(
      account:,
      created_by: admin,
      registration_params: { name: key_name, workflow_state: "on" },
      configuration_params:,
      developer_key_params: { name: key_name, scopes: }
    )
  end

dev_key = registration.developer_key
dev_key.update!(workflow_state: "active") unless dev_key.active?

# Always re-sync the inline public_jwk to the tool's CURRENT signing key — the
# tool may have regenerated its key (e.g. a fresh DB or rotated secret) since a
# prior run, and a stale embedded key would fail client-assertion verification.
if public_jwk
  tc = registration.manual_configuration
  tc.update!(public_jwk: public_jwk, public_jwk_url: nil) if tc&.respond_to?(:public_jwk)
  dev_key.update!(public_jwk: public_jwk, public_jwk_url: nil)
end

# Deploy into the COURSE context (if the seeded course exists) so the tool is
# launchable in-course; fall back to the root account otherwise. Account-level
# tools do not reliably surface a course launch in current Canvas.
course = Course.where(course_code: ENV.fetch("PG_COURSE_CODE", "PAW-E2E")).first
deploy_context = course || account

tool = registration.deployments.find do |t|
  t.context_type == deploy_context.class.base_class.name && t.context_id == deploy_context.id
end
tool ||= registration.new_external_tool(deploy_context, current_user: admin)
# "public" workflow_state = public privacy level (share name/email on launch).
tool.update!(workflow_state: "public") unless tool.workflow_state == "public"

puts "CLIENT_ID=#{dev_key.global_id}"
puts "DEPLOYMENT_ID=#{tool.deployment_id}"
puts "TOOL_ID=#{tool.id}"
puts "ISSUER=#{Canvas::Security.config['lti_iss'] rescue 'https://canvas.instructure.com'}"

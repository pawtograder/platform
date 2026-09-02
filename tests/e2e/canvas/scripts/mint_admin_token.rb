# rails runner script: mint (or reuse) an admin API access token.
#
# Finds the site-admin user created by db:initial_setup (by the
# CANVAS_LMS_ADMIN_EMAIL pseudonym) and creates a developer-key-less personal
# access token with no scope restriction (full admin API access). Prints the
# plaintext token exactly once as:  TOKEN=<value>
#
# Idempotent-ish: it always creates a fresh token (Canvas only reveals the
# plaintext at creation time, so we cannot "reuse" an existing one's plaintext).
# Re-running simply adds another token; old ones keep working until deleted.

email = ENV.fetch("CANVAS_LMS_ADMIN_EMAIL", "canvas@example.com")

pseudonym = Pseudonym.active.by_unique_id(email).first
abort("ERROR: no pseudonym for #{email}; run db:initial_setup first") unless pseudonym
user = pseudonym.user

token = user.access_tokens.create!(
  purpose: "pawtograder-e2e-admin",
  # no scopes => full access for the user's permissions (site admin)
)

# full_token is only populated right after create
puts "TOKEN=#{token.full_token}"

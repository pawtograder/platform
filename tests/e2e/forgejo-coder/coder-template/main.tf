# The lane's stand-in for charts/pawtograder/files/coder-templates/kubernetes/main.tf, pushed as `kubernetes`
# (the name workspace-open asks for). Everything a workspace-open caller can see is copied from the chart's
# template: the repo_url parameter and its validation, the GitHub external auth slot, the "Git Clone" script
# (the chart's own clone.sh, mounted beside this file), the agent's startup script and the code-server app.
# Only the compute differs: the lane has no Kubernetes, so instead of a pod the agent runs in the `workspace`
# container (docker-compose.yml), which starts whatever agent this template hands it in /agents. Keep the
# copied blocks in step with the chart's.

terraform {
  required_providers {
    coder = {
      source  = "coder/coder"
      version = "2.19.0"
    }
  }
}

variable "arch" {
  type        = string
  description = "CPU architecture of the workspace image (the agent binary must match)."
  default     = "amd64"
}

variable "code_server_version" {
  type        = string
  description = "code-server release to run; the workspace image's is used when it matches."
  default     = "4.143.1"
}

variable "forgejo_url" {
  type        = string
  description = "Forgejo's public URL; repo_url must name a repository on it or on github_url. Empty drops the pin."
  default     = ""
}

variable "github_url" {
  type        = string
  description = "GitHub's URL; repo_url may name a repository on it. Empty drops it from the pin."
  default     = "https://github.com"
}

variable "github_external_auth_id" {
  type        = string
  description = "Coder external auth provider id for GitHub; empty declares no provider."
  default     = ""
}

data "coder_parameter" "repo_url" {
  name         = "repo_url"
  display_name = "Repository"
  description  = "HTTPS clone URL of the repository to work on."
  type         = "string"
  mutable      = false
  validation {
    regex = local.repo_url_regex
    error = "Must be a clone URL like ${length(local.repo_url_origins) == 0 ? "https://<host>" : local.repo_url_origins[0]}/<owner>/<repository>.git, whose repository name doesn't start with a dot."
  }
}

data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

data "coder_external_auth" "github" {
  count    = var.github_external_auth_id == "" ? 0 : 1
  id       = var.github_external_auth_id
  optional = true
}

resource "coder_script" "git_clone" {
  agent_id     = coder_agent.main.id
  display_name = "Git Clone"
  icon         = "/icon/git.svg"
  script = templatefile("${path.module}/clone.sh", {
    url     = data.coder_parameter.repo_url.value
    dir     = local.repo_dir
    limit   = local.clone_timeout
    creds   = local.git_credentials
    auth_id = local.clone_auth_id
  })
  run_on_start       = true
  start_blocks_login = true
  timeout            = local.clone_timeout + 120
}

locals {
  repo_url_origins = compact([trimsuffix(var.forgejo_url, "/"), trimsuffix(var.github_url, "/")])
  repo_url_hosts   = join("|", [for origin in local.repo_url_origins : replace(origin, "/[\\\\.^$|?*+()\\[\\]{}]/", "\\$0")])
  repo_url_regex   = "^((${local.repo_url_hosts == "" ? "https://[A-Za-z0-9.-]+(:[0-9]+)?" : local.repo_url_hosts})/[A-Za-z0-9_.-]+/[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$"
  repo_dir         = "/home/coder/${trimsuffix(basename(data.coder_parameter.repo_url.value), ".git")}"
  repo_origin      = lower(try(regex("^[^:/]+://[^/]+", data.coder_parameter.repo_url.value), ""))
  on_forgejo       = var.forgejo_url != "" && local.repo_origin == lower(try(regex("^[^:/]+://[^/]+", var.forgejo_url), ""))
  repo_path        = try(regex("^https?://.+/([^/]+)/([^/]+?)(?:\\.git)?$", data.coder_parameter.repo_url.value), ["", ""])
  git_credentials  = local.on_forgejo ? "/home/coder/.git-credentials-${local.repo_path[0]}--${local.repo_path[1]}" : ""
  clone_auth_id    = local.on_forgejo ? "" : var.github_external_auth_id
  clone_timeout    = 300
}

resource "coder_agent" "main" {
  os   = "linux"
  arch = var.arch
  env = {
    OWNER_GIT_NAME  = contains(["", "default"], data.coder_workspace_owner.me.full_name) || strcontains(data.coder_workspace_owner.me.full_name, "@") ? data.coder_workspace_owner.me.name : data.coder_workspace_owner.me.full_name
    OWNER_GIT_EMAIL = data.coder_workspace_owner.me.email
  }
  startup_script = <<-EOT
    set -e
    git config --global user.name "$OWNER_GIT_NAME"
    EMAIL="$(head -n 1 /home/coder/.git-email 2>/dev/null || true)"
    git config --global user.email "$${EMAIL:-$OWNER_GIT_EMAIL}"
    V="${var.code_server_version}"
    CS="$(command -v code-server || true)"
    if [ -n "$V" ] && { [ -z "$CS" ] || [ "$("$CS" --version 2>/dev/null | awk '/^[0-9]+[.][0-9]+[.][0-9]+ /{print $1; exit}')" != "$V" ]; }; then
      CS="$HOME/.local/lib/code-server-$V/bin/code-server"
      if [ ! -x "$CS" ]; then
        mkdir -p "$HOME/.local/lib"
        rm -rf "$HOME"/.local/lib/.code-server-*
        tmp="$(mktemp -d "$HOME/.local/lib/.code-server-XXXXXX")"
        curl -fsSL "https://github.com/coder/code-server/releases/download/v$V/code-server-$V-linux-${var.arch}.tar.gz" | tar -xz -C "$tmp"
        rm -rf "$HOME/.local/lib/code-server-$V"
        mv "$tmp/code-server-$V-linux-${var.arch}" "$HOME/.local/lib/code-server-$V"
        rmdir "$tmp"
      fi
    fi
    [ -n "$CS" ] || { echo "the workspace image has no code-server and code_server_version is empty" >&2; exit 1; }
    S="$HOME/.local/share/code-server/Machine/settings.json"
    [ -f "$S" ] || { mkdir -p "$(dirname "$S")" && echo '{"git.useIntegratedAskPass": false}' >"$S"; }
    "$CS" --auth none --port 13337 >/tmp/code-server.log 2>&1 &
  EOT
}

resource "coder_app" "code_server" {
  agent_id     = coder_agent.main.id
  slug         = "code-server"
  display_name = "VS Code"
  url          = "http://localhost:13337/?folder=${local.repo_dir}"
  icon         = "/icon/code.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:13337/healthz"
    interval  = 5
    threshold = 6
  }
}

# The lane's compute. Terraform runs inside the Coder container, which shares /agents with the `workspace`
# container: a start hands over the agent's token and init script in /agents/<id>, and a stop asks for that
# agent to be stopped. The directory appears in one rename, so the workspace container never sees half of it.
resource "terraform_data" "agent" {
  count = data.coder_workspace.me.start_count

  provisioner "local-exec" {
    command = "set -e; d=/agents/${self.id}; mkdir -p \"$d.tmp\"; printf '%s' \"$AGENT_TOKEN\" >\"$d.tmp/token\"; printf '%s' \"$INIT_SCRIPT\" >\"$d.tmp/init.sh\"; mv \"$d.tmp\" \"$d\""
    environment = {
      AGENT_TOKEN = coder_agent.main.token
      INIT_SCRIPT = coder_agent.main.init_script
    }
  }

  provisioner "local-exec" {
    when    = destroy
    command = "touch /agents/${self.id}/stop || true"
  }
}

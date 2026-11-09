# The namespace ResourceQuota rejects pods without explicit requests and limits.

terraform {
  required_providers {
    coder = {
      source  = "coder/coder"
      version = "2.19.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "3.4.0"
    }
  }
}

provider "kubernetes" {}

variable "namespace" {
  type        = string
  description = "Namespace workspaces are created in (coderd's own)."
}

variable "node_selector" {
  type        = string
  description = "JSON object of node labels for workspace pods."
  default     = "{}"
}

variable "tolerations" {
  type        = string
  description = "JSON list of Kubernetes tolerations for workspace pods."
  default     = "[]"
}

variable "node_affinity" {
  type        = string
  description = "JSON Kubernetes nodeAffinity for workspace pods."
  default     = "{}"
}

variable "arch" {
  type        = string
  description = "CPU architecture of the workspace image and nodes (the agent binary must match)."
  default     = "amd64"
}

variable "image_pull_policy" {
  type        = string
  description = "Pull policy for the workspace image."
  default     = "IfNotPresent"
}

variable "image_pull_secrets" {
  type        = string
  description = "JSON list of Secret names for pulling the workspace image."
  default     = "[]"
}

variable "home_storage_class" {
  type        = string
  description = "StorageClass for workspace home volumes; empty uses the cluster default."
  default     = ""
}

variable "priority_class_name" {
  type        = string
  description = "PriorityClass for workspace pods; empty uses the cluster default."
  default     = ""
}

variable "ephemeral_storage_limit" {
  type        = string
  description = "Cap on what a workspace writes outside its home volume (/tmp, the image layer)."
  default     = "4Gi"
}

variable "code_server_version" {
  type        = string
  description = "code-server release to run, downloaded into the home volume unless the image's code-server is this version; empty uses the image's."
  default     = "4.143.1"
}

variable "image" {
  type        = string
  description = "Workspace container image."
  default     = "ghcr.io/pawtograder/mirror/codercom/enterprise-base:ubuntu-20261005"
}

variable "external_auth_id" {
  type        = string
  description = "ID of the Coder external auth provider (CODER_EXTERNAL_AUTH_<n>_ID) whose token clones and pushes the repository."
  default     = "forgejo"
}

variable "forgejo_url" {
  type        = string
  description = "Forgejo's public URL; repo_url must name a repository on it. Empty accepts any HTTPS host."
  default     = ""
}

data "coder_parameter" "cpu" {
  name         = "cpu"
  display_name = "CPU"
  type         = "number"
  default      = "2"
  mutable      = true
  option {
    name  = "1 core"
    value = "1"
  }
  option {
    name  = "2 cores"
    value = "2"
  }
}

data "coder_parameter" "memory" {
  name         = "memory"
  display_name = "Memory (GiB)"
  type         = "number"
  default      = "4"
  mutable      = true
  option {
    name  = "2 GiB"
    value = "2"
  }
  option {
    name  = "4 GiB"
    value = "4"
  }
}

data "coder_parameter" "home_disk_size" {
  name         = "home_disk_size"
  display_name = "Home disk (GiB)"
  type         = "number"
  default      = "5"
  mutable      = false
  validation {
    min = 1
    max = 20
  }
}

data "coder_parameter" "repo_url" {
  name         = "repo_url"
  display_name = "Repository"
  description  = "HTTPS clone URL of the repository to work on."
  type         = "string"
  mutable      = false
  validation {
    regex = local.repo_url_regex
    error = "Must be a clone URL like ${var.forgejo_url == "" ? "https://<host>" : trimsuffix(var.forgejo_url, "/")}/<owner>/<repository>.git, whose repository name doesn't start with a dot."
  }
}

# Coder refuses to create a workspace until the owner links this provider; the agent's GIT_ASKPASS then hands git its token.
data "coder_external_auth" "git" {
  id = var.external_auth_id
}

data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# Blocks login until it ends, so a failure shows as the agent's start_error rather than a ready workspace.
resource "coder_script" "git_clone" {
  agent_id     = coder_agent.main.id
  display_name = "Git Clone"
  icon         = "/icon/git.svg"
  script = templatefile("${path.module}/clone.sh", {
    url   = data.coder_parameter.repo_url.value
    dir   = local.repo_dir
    limit = local.clone_timeout
    auth  = var.external_auth_id
  })
  run_on_start       = true
  start_blocks_login = true
  # A backstop: clone.sh gives up on its own after clone_timeout.
  timeout = local.clone_timeout + 120
}

locals {
  # Owner and repository names are Forgejo's characters; a name can't start with a dot, so the clone can't land on a dotfile.
  # "" passes because template import checks the parameter without a value; clone.sh fails a workspace created with it.
  repo_url_regex = "^(${var.forgejo_url == "" ? "https://[A-Za-z0-9.-]+(:[0-9]+)?" : replace(trimsuffix(var.forgejo_url, "/"), "/[\\\\.^$|?*+()\\[\\]{}]/", "\\$0")}/[A-Za-z0-9_.-]+/[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$"
  repo_dir       = "/home/coder/${trimsuffix(basename(data.coder_parameter.repo_url.value), ".git")}"
  clone_timeout  = 300
  # Owner and workspace names can be renamed; object names can't, and a renamed PVC would be replaced.
  name = "coder-${data.coder_workspace.me.id}"
  labels = {
    "app.kubernetes.io/name"     = "coder-workspace"
    "app.kubernetes.io/instance" = data.coder_workspace.me.id
    "app.kubernetes.io/part-of"  = "pawtograder-stack"
    "com.coder.workspace.id"     = data.coder_workspace.me.id
    "com.coder.user.id"          = data.coder_workspace_owner.me.id
  }
}

resource "coder_agent" "main" {
  os   = "linux"
  arch = var.arch
  # Passed as variables so a quote in a name can't break the script.
  env = {
    OWNER_GIT_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    OWNER_GIT_EMAIL = data.coder_workspace_owner.me.email
  }
  startup_script = <<-EOT
    set -e
    git config --global user.name "$OWNER_GIT_NAME"
    git config --global user.email "$OWNER_GIT_EMAIL"
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
    "$CS" --auth none --port 13337 >/tmp/code-server.log 2>&1 &
  EOT

  metadata {
    display_name = "CPU"
    key          = "cpu"
    script       = "coder stat cpu"
    interval     = 10
    timeout      = 1
  }
  metadata {
    display_name = "Memory"
    key          = "mem"
    script       = "coder stat mem"
    interval     = 10
    timeout      = 1
  }
  metadata {
    display_name = "Home disk"
    key          = "home"
    script       = "coder stat disk --path $HOME"
    interval     = 60
    timeout      = 1
  }
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

resource "kubernetes_persistent_volume_claim_v1" "home" {
  metadata {
    name      = "${local.name}-home"
    namespace = var.namespace
    labels    = local.labels
  }
  wait_until_bound = false
  # Each forces replacement, which deletes the home; changing these applies to new workspaces only.
  lifecycle {
    ignore_changes = [metadata[0].name, metadata[0].namespace, spec[0].storage_class_name]
  }
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = var.home_storage_class == "" ? null : var.home_storage_class
    resources {
      requests = {
        storage = "${data.coder_parameter.home_disk_size.value}Gi"
      }
    }
  }
}

resource "kubernetes_pod_v1" "main" {
  count = data.coder_workspace.me.start_count

  metadata {
    name = local.name
    # The home PVC keeps its original namespace, and a pod can only mount a claim in its own.
    namespace = kubernetes_persistent_volume_claim_v1.home.metadata[0].namespace
    labels    = local.labels
  }

  spec {
    automount_service_account_token = false
    restart_policy                  = "Always"
    priority_class_name             = var.priority_class_name == "" ? null : var.priority_class_name
    node_selector                   = merge(jsondecode(var.node_selector), { "kubernetes.io/arch" = var.arch })

    dynamic "image_pull_secrets" {
      for_each = jsondecode(var.image_pull_secrets)
      content {
        name = image_pull_secrets.value
      }
    }

    dynamic "affinity" {
      for_each = var.node_affinity == "{}" ? [] : [jsondecode(var.node_affinity)]
      content {
        node_affinity {
          dynamic "required_during_scheduling_ignored_during_execution" {
            for_each = can(affinity.value.requiredDuringSchedulingIgnoredDuringExecution) ? [affinity.value.requiredDuringSchedulingIgnoredDuringExecution] : []
            content {
              dynamic "node_selector_term" {
                for_each = required_during_scheduling_ignored_during_execution.value.nodeSelectorTerms
                content {
                  dynamic "match_expressions" {
                    for_each = lookup(node_selector_term.value, "matchExpressions", [])
                    content {
                      key      = match_expressions.value.key
                      operator = match_expressions.value.operator
                      values   = lookup(match_expressions.value, "values", null)
                    }
                  }
                  dynamic "match_fields" {
                    for_each = lookup(node_selector_term.value, "matchFields", [])
                    content {
                      key      = match_fields.value.key
                      operator = match_fields.value.operator
                      values   = lookup(match_fields.value, "values", null)
                    }
                  }
                }
              }
            }
          }
          dynamic "preferred_during_scheduling_ignored_during_execution" {
            for_each = lookup(affinity.value, "preferredDuringSchedulingIgnoredDuringExecution", [])
            content {
              weight = preferred_during_scheduling_ignored_during_execution.value.weight
              preference {
                dynamic "match_expressions" {
                  for_each = lookup(preferred_during_scheduling_ignored_during_execution.value.preference, "matchExpressions", [])
                  content {
                    key      = match_expressions.value.key
                    operator = match_expressions.value.operator
                    values   = lookup(match_expressions.value, "values", null)
                  }
                }
                dynamic "match_fields" {
                  for_each = lookup(preferred_during_scheduling_ignored_during_execution.value.preference, "matchFields", [])
                  content {
                    key      = match_fields.value.key
                    operator = match_fields.value.operator
                    values   = lookup(match_fields.value, "values", null)
                  }
                }
              }
            }
          }
        }
      }
    }

    dynamic "toleration" {
      for_each = jsondecode(var.tolerations)
      content {
        key                = lookup(toleration.value, "key", null)
        operator           = lookup(toleration.value, "operator", null)
        value              = lookup(toleration.value, "value", null)
        effect             = lookup(toleration.value, "effect", null)
        toleration_seconds = lookup(toleration.value, "tolerationSeconds", null)
      }
    }

    security_context {
      run_as_user     = 1000
      run_as_group    = 1000
      fs_group        = 1000
      run_as_non_root = true
      seccomp_profile {
        type = "RuntimeDefault"
      }
    }

    container {
      name              = "dev"
      image             = var.image
      image_pull_policy = var.image_pull_policy
      command           = ["sh", "-c", coder_agent.main.init_script]

      env {
        name  = "CODER_AGENT_TOKEN"
        value = coder_agent.main.token
      }

      security_context {
        allow_privilege_escalation = false
        capabilities {
          drop = ["ALL"]
        }
      }

      resources {
        requests = {
          cpu                 = "250m"
          memory              = "512Mi"
          "ephemeral-storage" = "256Mi"
        }
        limits = {
          cpu                 = data.coder_parameter.cpu.value
          memory              = "${data.coder_parameter.memory.value}Gi"
          "ephemeral-storage" = var.ephemeral_storage_limit
        }
      }

      volume_mount {
        name       = "home"
        mount_path = "/home/coder"
      }
    }

    volume {
      name = "home"
      persistent_volume_claim {
        claim_name = kubernetes_persistent_volume_claim_v1.home.metadata[0].name
      }
    }
  }
}

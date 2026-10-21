# The namespace ResourceQuota rejects pods without explicit requests and limits.

terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    kubernetes = {
      source = "hashicorp/kubernetes"
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

variable "ephemeral_storage_limit" {
  type        = string
  description = "Cap on what a workspace writes outside its home volume (/tmp, the image layer)."
  default     = "4Gi"
}

variable "image" {
  type        = string
  description = "Workspace container image."
  default     = "ghcr.io/pawtograder/mirror/codercom/enterprise-base:ubuntu-20261005"
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

data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

locals {
  name = "coder-${lower(data.coder_workspace_owner.me.name)}-${lower(data.coder_workspace.me.name)}"
  labels = {
    "app.kubernetes.io/name"     = "coder-workspace"
    "app.kubernetes.io/instance" = data.coder_workspace.me.id # local.name can pass the 63-char label limit
    "app.kubernetes.io/part-of"  = "pawtograder-stack"
    "com.coder.workspace.id"     = data.coder_workspace.me.id
    "com.coder.user.id"          = data.coder_workspace_owner.me.id
  }
}

resource "coder_agent" "main" {
  os             = "linux"
  arch           = "amd64"
  startup_script = <<-EOT
    set -e
    if [ ! -x "$HOME/.local/bin/code-server" ]; then
      curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix="$HOME/.local"
    fi
    "$HOME/.local/bin/code-server" --auth none --port 13337 >/tmp/code-server.log 2>&1 &
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
  url          = "http://localhost:13337/?folder=/home/coder"
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
  spec {
    access_modes = ["ReadWriteOnce"]
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
    name      = local.name
    namespace = var.namespace
    labels    = local.labels
  }

  spec {
    automount_service_account_token = false
    restart_policy                  = "Always"
    node_selector                   = jsondecode(var.node_selector)

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
      run_as_user  = 1000
      run_as_group = 1000
      fs_group     = 1000
    }

    container {
      name              = "dev"
      image             = var.image
      image_pull_policy = "IfNotPresent"
      command           = ["sh", "-c", coder_agent.main.init_script]

      env {
        name  = "CODER_AGENT_TOKEN"
        value = coder_agent.main.token
      }

      security_context {
        allow_privilege_escalation = false
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

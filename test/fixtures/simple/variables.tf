variable "env" {
  type        = string
  description = "Environment name"
  default     = "dev"
}

variable "lista" {
  type    = list(string)
  default = ["a", "b"]
}

variable "cidr" {
  type = string
}

variable "replicas" {
  type = string
}

variable "only_prod" {
  type    = bool
  default = false
}

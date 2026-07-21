variable "env" {
  type        = string
  description = "Environment name"
  default     = "dev"
}

variable "cidr" {
  type = string
}

variable "lista" {
  type    = list(string)
  default = ["a", "b"]
}

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.34.0"
    }
  }
}

locals {
  name_prefix = "${var.env}-app"
}

resource "aws_db_instance" "main" {
  identifier = local.name_prefix
  count      = length(var.lista)
  name       = var.lista[count.index]

  lifecycle {
    prevent_destroy = true
  }
}

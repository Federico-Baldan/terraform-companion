terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.34.0"
    }
  }
}

locals {
  bucket = "${var.env}-artifacts"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = local.bucket
}

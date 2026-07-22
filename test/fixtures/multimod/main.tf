terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.34.0"
    }
  }
}

module "net" {
  source = "./modules/net"
  cidr   = var.cidr
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "3.0.0"
}

module "unpinned" {
  source = "terraform-aws-modules/s3-bucket/aws"
}

resource "aws_instance" "web" {
  subnet_id = module.net.subnet_id
  tags      = local.tags
}

resource "aws_db_instance" "db" {
  identifier     = local.name_prefix
  instance_class = "db.t3.micro"
}

output "web_id" {
  value = aws_instance.web.id
}

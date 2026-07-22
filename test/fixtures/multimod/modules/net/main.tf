resource "aws_subnet" "a" {
  vpc_id     = "vpc-00000000"
  cidr_block = var.cidr
}

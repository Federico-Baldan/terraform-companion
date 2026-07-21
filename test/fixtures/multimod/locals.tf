locals {
  name_prefix  = "${var.env}-app"
  tags         = { Name = local.name_prefix }
  unused_thing = "never-referenced"
}

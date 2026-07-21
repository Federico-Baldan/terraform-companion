# Changelog

Notable changes to Terraform Companion. Versions follow semver; dates are ISO (YYYY-MM-DD).

## [1.1.2](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.1...v1.1.2) (2026-07-21)


### Bug Fixes

* restore the tf-companion extension id ([59c7a72](https://github.com/Federico-Baldan/terraform-companion/commit/59c7a7201f8d912af5c370876f6e60c785710a4a))

## [1.1.1](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.0...v1.1.1) (2026-07-21)


### Bug Fixes

* publish under the terraform-companion extension id ([cf0011a](https://github.com/Federico-Baldan/terraform-companion/commit/cf0011a6239941ca927cc26ab7809b3adbb2f7ad))

## [1.1.0](https://github.com/Federico-Baldan/terraform-companion/compare/v1.0.0...v1.1.0) (2026-07-21)


### Features

* enhance CI/CD workflows and update project metadata ([deb5b97](https://github.com/Federico-Baldan/terraform-companion/commit/deb5b97a8dd27ecfd3109908f6b2bac281778175))

## 1.0.0 - 2026-07-20

First public release.

- **Version CodeLens** on registry provider and module `version` constraints, showing the newest published release and how far the constraint sits from it. Click to rewrite the constraint or open the registry page. Distance is measured from the version the constraint would actually install, and ranges that exclude the newest release are reported as blocked rather than silently skipped. Responses cached for six hours.
- **Resolved-value hover** on `var.*`, `local.*`, and definition names, following the var→local chain to the final string and naming where it came from. Inside a called module, values resolve from the call site upward to the root module and its tfvars, falling back to the module default. Multiple call sites are listed separately instead of collapsed into one.
- **count → for_each** detection for the `count = length(var.list)` plus `var.list[count.index]` pattern, with a quick fix that rewrites the block to `for_each` and `each.value`.
- **Unused locals** warning on any `local` nothing in its module references.
- **Version hygiene** for registry modules declared without a `version` and `>=` constraints with no upper bound. Variables missing a `description` or `type` are covered by an opt-in setting.
- **Redundant depends_on** warning when an entry duplicates a dependency the block's arguments already create, plus a quick fix that removes it.
- **.terraform cache cleanup** on startup for modules idle beyond 30 days, prompting before deleting. Freshness accounts for `terraform workspace` state directories. Only directories named exactly `.terraform` are removed and symlinks are never followed.

Every feature has a `tfCompanion.<feature>.enabled` toggle. The CodeLens is the only feature that touches the network, and it degrades to its cache without surfacing errors.

# Changelog

Notable changes to Terraform Companion. Versions follow semver; dates are ISO (YYYY-MM-DD).

## [1.1.5](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.4...v1.1.5) (2026-07-22)


### Documentation

* refresh the resolved-hover demo gif and move it under the header ([3933b6b](https://github.com/Federico-Baldan/terraform-companion/commit/3933b6b8b9d5b183a48cc4bf448fe56369a544b3))

## [1.1.4](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.3...v1.1.4) (2026-07-22)


### Features

* scope tfvars pins to a module and add a proximity picker ([#9](https://github.com/Federico-Baldan/terraform-companion/issues/9)) ([4b6c1dd](https://github.com/Federico-Baldan/terraform-companion/commit/4b6c1dd3ec32614ef903f46f90ac71f85c513eca))


### Miscellaneous Chores

* release 1.1.4 ([d3d155e](https://github.com/Federico-Baldan/terraform-companion/commit/d3d155e227f389c9b04398b04ea0ec38e2b10c32))

## [1.1.3](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.2...v1.1.3) (2026-07-21)


### Bug Fixes

* align the VS Code floor with the newest API definitions that exist ([2122c51](https://github.com/Federico-Baldan/terraform-companion/commit/2122c51d71d02f83477a862285b1e2517c3f3376))
* lower the VS Code floor to 1.125, matching the API actually used ([e1b6400](https://github.com/Federico-Baldan/terraform-companion/commit/e1b6400f2b2f1eb66983f5b4992807274740a9a6))
* set the VS Code floor to 1.128 and slow its automatic bumps ([bda68c9](https://github.com/Federico-Baldan/terraform-companion/commit/bda68c9b96a92f36ca4db2f3a95b70c254a856e3))
* sync the lockfile engines field with package.json ([ce8369e](https://github.com/Federico-Baldan/terraform-companion/commit/ce8369e8e271fd213d0fdc047687676c292673f8))

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

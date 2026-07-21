# Changelog

Notable changes to Terraform Companion. Versions follow semver; dates are ISO (YYYY-MM-DD).

## 1.1.2 - 2026-07-21

First version on the Marketplace. Nothing in the extension changed: every
feature below is exactly as it shipped in 1.0.0.

The three version numbers between the two were spent getting the release
pipeline right, and none of them reached anyone. Releases are cut
automatically from commit messages now, so from here on every entry in this
file is a real change to what the extension does.

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

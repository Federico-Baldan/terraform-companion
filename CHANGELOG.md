# Changelog

Notable changes to Terraform Companion. Versions follow semver; dates are ISO (YYYY-MM-DD).

## [1.3.1](https://github.com/Federico-Baldan/terraform-companion/compare/v1.3.0...v1.3.1) (2026-11-14)


### Bug Fixes

* **deps:** update dependency web-tree-sitter to v0.27.2 ([#100](https://github.com/Federico-Baldan/terraform-companion/issues/100)) ([f4abfd0](https://github.com/Federico-Baldan/terraform-companion/commit/f4abfd03179ac915a512567065504cf2446b244a))

## [1.3.0](https://github.com/Federico-Baldan/terraform-companion/compare/v1.2.5...v1.3.0) (2026-11-08)


### Features

* cleanup of the shared Terraform provider cache ([#90](https://github.com/Federico-Baldan/terraform-companion/issues/90)) ([a01724e](https://github.com/Federico-Baldan/terraform-companion/commit/a01724e3ca81284f59d716ccf6e08ce3bf47f147))
* context-aware resolved hover ([#89](https://github.com/Federico-Baldan/terraform-companion/issues/89)) ([55d9df2](https://github.com/Federico-Baldan/terraform-companion/commit/55d9df2fb9635e34e21933af6c691799495cbbd4))


### Bug Fixes

* a file past the parse limit also withholds across modules ([10abbc3](https://github.com/Federico-Baldan/terraform-companion/commit/10abbc3199a245f48a1792341510ee7f69e920e0))
* **deps:** update dependency semver to ^7.8.6 ([#87](https://github.com/Federico-Baldan/terraform-companion/issues/87)) ([af93eee](https://github.com/Federico-Baldan/terraform-companion/commit/af93eeeda6e38aebd4b40c689546f9002329e1e6))
* do not certify a list when a budget gave up on one of its elements ([c1c7fe0](https://github.com/Federico-Baldan/terraform-companion/commit/c1c7fe09b900f6a514eeb011eb3ee01161ca37db))
* do not hand a file past 1 MiB to the parser ([70ed9cf](https://github.com/Federico-Baldan/terraform-companion/commit/70ed9cf98ca4507a28bb9ab787de52c90b31d566))
* name a too-large file from whichever path indexes it, and again if it returns ([fe3d8a5](https://github.com/Federico-Baldan/terraform-companion/commit/fe3d8a5ad89adfec9836dbd313552f29237f1213))
* note an unread caller on path.* too, and keep "no value" next to an assumption ([11d2e4b](https://github.com/Federico-Baldan/terraform-companion/commit/11d2e4b922105e101567ae0877df7c09ef78ea43))
* remember the references that gave up, so a doubling ladder stops freezing the host ([0e0371d](https://github.com/Federico-Baldan/terraform-companion/commit/0e0371d861562e52e30ac9b3bf80a542b57a8833))
* scan for the callee and for lock-file providers in one pass, not from every position ([6cdb2a2](https://github.com/Federico-Baldan/terraform-companion/commit/6cdb2a210b001e17eb2c55165b85aa56b3e6492b))
* stop the count -&gt; for_each safety check pinning a call site it already pinned ([94ca7df](https://github.com/Federico-Baldan/terraform-companion/commit/94ca7dfe1e9301a23c90fef912027a04860e5263))


### Performance Improvements

* bound the disk reads a burst of file events starts, and skip the superseded ones ([bb2c245](https://github.com/Federico-Baldan/terraform-companion/commit/bb2c2455c2d1f9d669d288d545907277bc23baae))
* bound the parse memo by the text it holds, not only by how many files ([aced408](https://github.com/Federico-Baldan/terraform-companion/commit/aced4082c8c90b2b4238b745fce3bc7faead71c8))
* bound the text a resolve parses, and list a module's locals once ([af011b4](https://github.com/Federico-Baldan/terraform-companion/commit/af011b4d3324d0a3ee122cbfb43f5b7fa2c08a74))
* cap the reference evaluations one resolve may start ([a36377e](https://github.com/Federico-Baldan/terraform-companion/commit/a36377ee068610f2cb52d6a4685b4636803402ca))
* share one parse of a buffer between the providers that ask about it ([ea7c99d](https://github.com/Federico-Baldan/terraform-companion/commit/ea7c99d4f4411185df9f78bdbe9feecbcf0b322a))
* skip the cache cleaner's lock-file walk when no shared plugin cache exists ([fd741c0](https://github.com/Federico-Baldan/terraform-companion/commit/fd741c0f82700bf49b6734bc9ef2c4efea3f0ccb))
* stop scanning the whole workspace to answer questions about one module ([2aa5fbf](https://github.com/Federico-Baldan/terraform-companion/commit/2aa5fbf3225fbe3e01cd66bad5985a9bbba4ab18))

## [1.2.5](https://github.com/Federico-Baldan/terraform-companion/compare/v1.2.4...v1.2.5) (2026-10-23)


### Bug Fixes

* use supported VSCE Entra credential flag ([0733146](https://github.com/Federico-Baldan/terraform-companion/commit/07331465ffe045cf809fb93e167114603a84e843))

## [1.2.4](https://github.com/Federico-Baldan/terraform-companion/compare/v1.2.3...v1.2.4) (2026-10-23)


### Bug Fixes

* **deps:** update dependency web-tree-sitter to v0.27.1 ([#66](https://github.com/Federico-Baldan/terraform-companion/issues/66)) ([ec9132a](https://github.com/Federico-Baldan/terraform-companion/commit/ec9132ab77a235d86ece30e62389a55a85f6b97d))
* update CI and release workflows to use OIDC for publishing to VS Code Marketplace ([bcf95f6](https://github.com/Federico-Baldan/terraform-companion/commit/bcf95f64cbc838baf4eecd20ddf7c2a7c3f56d9d))

## [1.2.3](https://github.com/Federico-Baldan/terraform-companion/compare/v1.2.2...v1.2.3) (2026-10-05)


### Documentation

* sign the README and point the Marketplace homepage at federico.baldan.dev ([f466bd6](https://github.com/Federico-Baldan/terraform-companion/commit/f466bd614b0d771e9a42db7b486b220fa9ba9960))

## [1.2.2](https://github.com/Federico-Baldan/terraform-companion/compare/v1.2.1...v1.2.2) (2026-09-25)


### Documentation

* animate the logo at the top of the README ([97071e6](https://github.com/Federico-Baldan/terraform-companion/commit/97071e67c4e600ba2c3135d18207be4214141345))

## [1.2.1](https://github.com/Federico-Baldan/terraform-companion/compare/v1.2.0...v1.2.1) (2026-09-13)


### Bug Fixes

* **deps:** update dependency web-tree-sitter to v0.27.0 ([#41](https://github.com/Federico-Baldan/terraform-companion/issues/41)) ([f40470f](https://github.com/Federico-Baldan/terraform-companion/commit/f40470fa88d0aca96f71fd485e2e4e3eba54d99e))

## [1.2.0](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.10...v1.2.0) (2026-09-01)


### Features

* **cacheCleaner:** name the folders before deleting them ([351e6a3](https://github.com/Federico-Baldan/terraform-companion/commit/351e6a3d86863d7fe35994359f113704e859718c))


### Bug Fixes

* **deps:** update dependency web-tree-sitter to v0.26.13 ([78fd9a8](https://github.com/Federico-Baldan/terraform-companion/commit/78fd9a84342541bae24a1f3bc3dafac15e4d492c))

## [1.1.10](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.9...v1.1.10) (2026-08-24)


### Bug Fixes

* **deps:** update dependency web-tree-sitter to v0.26.12 ([#29](https://github.com/Federico-Baldan/terraform-companion/issues/29)) ([8b7b4d1](https://github.com/Federico-Baldan/terraform-companion/commit/8b7b4d1fbd7f5a3798c8eafb8dcbbc8c640557a1))

## [1.1.9](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.8...v1.1.9) (2026-08-10)


### Bug Fixes

* close a delete escape, a destructive refactor, and a parser crash ([139f674](https://github.com/Federico-Baldan/terraform-companion/commit/139f6745f62ecdd3e5ace483360a8883dbdc5b9e))
* close data-loss, crash and freeze paths, and cut per-edit CPU ([1fba66d](https://github.com/Federico-Baldan/terraform-companion/commit/1fba66dad3fd9756a361d3130df4d761b1f6b6b1))

## [1.1.8](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.7...v1.1.8) (2026-08-04)


### Bug Fixes

* cut extension-host CPU, RAM and I/O, and close two prod hazards ([#21](https://github.com/Federico-Baldan/terraform-companion/issues/21)) ([7960963](https://github.com/Federico-Baldan/terraform-companion/commit/7960963c80a0bbe3cb0642bb05d31a047710ef72))

## [1.1.7](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.6...v1.1.7) (2026-08-03)


### Bug Fixes

* bound registry requests and stop offering no-op version updates ([1be7287](https://github.com/Federico-Baldan/terraform-companion/commit/1be7287ca61ca2293a33647187d359db0caa1c74))
* bound the value renderer so a hover cannot freeze the editor ([369bd03](https://github.com/Federico-Baldan/terraform-companion/commit/369bd03dc6bace7e9131e3874331399ae5660e97))
* keep module paths anchored at a Windows drive or UNC root ([58ea927](https://github.com/Federico-Baldan/terraform-companion/commit/58ea927ead7ced9d6a2551705c27d43de1d66cb2))
* stop burning extension-host CPU on unrelated file activity ([118d2c8](https://github.com/Federico-Baldan/terraform-companion/commit/118d2c87f8c01ff6b7a9521ad32777caaa5a0ed7))

## [1.1.6](https://github.com/Federico-Baldan/terraform-companion/compare/v1.1.5...v1.1.6) (2026-07-31)


### Bug Fixes

* stop quick fixes editing working config, and unfreeze a 73s hover ([8e4968d](https://github.com/Federico-Baldan/terraform-companion/commit/8e4968da45e1d243239d78b89cbaa8693638c7d0))

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

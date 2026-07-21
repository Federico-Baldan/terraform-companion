<p align="center">
  <img src="assets/logo/icon-256.png" alt="Terraform Companion" width="128" height="128">
</p>

<h1 align="center">Terraform Companion</h1>

<p align="center">
  Version CodeLens, resolved-value hover on <code>var</code> and <code>local</code>, <code>count</code>&nbsp;→&nbsp;<code>for_each</code> refactor,<br>
  plus unused-local and version-constraint lints.
</p>

You almost certainly already run the [HashiCorp Terraform](https://marketplace.visualstudio.com/items?itemName=HashiCorp.terraform) extension. Keep it. Formatting, completion, syntax and validation all go through terraform-ls, and nothing here reaches into any of that.

This fills the gaps terraform-ls leaves: it won't tell you a provider constraint is a major release behind, and it won't tell you what `var.environment` resolves to until you run a plan. Install both and they stay out of each other's way.

Requires VS Code 1.129 or newer. Activates on `.tf` / `.tfvars` files.

## Version CodeLens

```hcl
terraform {
  required_providers {
    # → 6.0.1 blocked by your constraint (1 major)
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.34"
    }
  }
}
```

The lens sits over the `version` line. Click it to bump the constraint or jump to the registry page. It measures the gap from the release your constraint would actually install, not from the floor you typed, so a `~> 5.34` that can't cross into 6.x reads *blocked* rather than pretending everything's fine; an exact pin that could just be raised reads *behind*. Modules work the same way. Answers are cached six hours, and a source the registry doesn't recognise shows nothing at all instead of an error.

## Resolved-value hover

Point at a `var.*` or `local.*` and you get the string that actually lands there, plus its provenance: a tfvars file, a variable default, an argument passed at a `module` call. There's a copy link right in the hover.

It follows the whole chain. `local.name = "app-${var.env}"` with `var.env = "dev"` in tfvars resolves to `app-dev`, not a bare `dev`. Inside a called module, `var.*` comes from the call site and walks back up to the root and its tfvars, falling back to the module's own default when nobody passes it. Two `module` blocks passing different values? You get one line per instance instead of a lie about which one won.

A status bar item pins which tfvars file counts as active, for when auto-loading isn't what you want.

## count → for_each

```hcl
resource "aws_instance" "web" {
  count = length(var.instance_names)
  tags  = { Name = var.instance_names[count.index] }
}
```

Drop the first name from that list and Terraform destroys and recreates every instance after it, because `count` keys resources by position. The quick fix rewrites the block to `for_each = toset(...)` with `each.value` in place of the indexed reads, so each instance is keyed by its own value and reordering the list stops mattering.

It only offers the rewrite when the rewrite is safe. If `count.index` also drives something else in the block, if the resource is addressed by index somewhere else (`web[0]`, `web[*]`, a cross-file `depends_on`), if the elements get read as objects, or if the values would collapse under `toset()` because they're duplicates or not strings, the fix stays hidden. One caveat it can't fix for you: resources already in state need `terraform state mv`, since their addresses change from `[0]` to `["web"]`.

## Lints

- **Unused locals**, flagged on the definition line, scoped to the whole module so a local defined in one file and used in another doesn't get a false positive.
- **Version hygiene**: registry modules with no `version`, and `>=` / bare `~> 5` constraints that leave the upper end open. Optionally, variables missing a `description` or `type`.
- **Redundant `depends_on`**: an entry the block's own arguments already imply. The quick fix splices just that entry out and leaves your comments and formatting alone.

## .terraform cache cleanup

On startup it looks for `.terraform` folders whose module hasn't been touched in 30 days, and asks before deleting. These are caches `terraform init` rebuilds; the one thing you lose is the selected workspace, which resets to `default`. The scan never follows symlinks, so it can't wander out of the workspace, and it only ever removes a directory named exactly `.terraform`. Flip `cacheCleaner.autoDelete` on to skip the prompt.

## Offline

The CodeLens is the only thing that touches the network. No connection, or a registry that's down, and it serves the last cached answer or renders nothing — no popups, no red squiggles. Everything else runs entirely on your machine.

## Settings

All keys are under `tfCompanion.`

| Setting | Default | Notes |
|---|---|---|
| `versionLens.enabled` | `true` | |
| `versionLens.cacheTtlHours` | `6` | floored at 5 minutes |
| `resolvedHover.enabled` | `true` | |
| `countForEach.enabled` | `true` | |
| `dependsOn.enabled` | `true` | |
| `unusedLocals.enabled` | `true` | |
| `versionHygiene.enabled` | `true` | |
| `versionHygiene.variableDocs` | `false` | also flag variables without `description` or `type` |
| `cacheCleaner.enabled` | `true` | |
| `cacheCleaner.staleDays` | `30` | floored at 1 |
| `cacheCleaner.autoDelete` | `false` | delete without asking |

## Development

```bash
npm install
npm run build      # extension + WASM grammar into dist/
npm run watch      # rebuild on change
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run lint       # biome check
npm run package    # .vsix
```

MIT.

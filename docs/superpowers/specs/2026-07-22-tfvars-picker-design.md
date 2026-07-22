# tfvars picker: per-module pins, proximity shortlist, Browse

## Problem

The tfvars picker lists every `.tfvars` in the workspace as a flat, basename-labelled
list. Two problems, one cosmetic and one severe.

**Cosmetic:** a repo with 200 `prod.tfvars` renders 200 identical rows.

**Severe:** the pin is inert for the most common real-world layout. `ActiveTfvars.tfvarsFor`
kept a pin only when the pinned file lived in the module directory:

```ts
if (!pinned || this.index.moduleDirOf(pinned) !== moduleDir) return files;
```

Terraform repos split roughly two ways. Either each environment is its own root module
(`environments/prod/{main.tf,terraform.tfvars}`), where the tfvars sits in the module dir
and auto-loading already works — or a single root module is driven by a central vars
folder (`env/prod.tfvars`) via `-var-file`. In the second layout the pinned file is never
in the module dir, so the pin was always discarded: the status bar showed `tfvars: prod.tfvars`
while the hover resolved as if nothing were pinned. No test covered that layout, which is
why it survived.

## Design

### 1. Pins become per-module

`workspaceState['tfCompanion.activeTfvars']` changes from `string` to
`Record<moduleDir, tfvarsPath>`. The key is the module the pin applies to; the value may
live anywhere, which is what makes `-var-file` semantics expressible.

Migration: a stored `string` is read as `{ [moduleDirOf(stored)]: stored }` — exactly the
old behaviour, so no one loses a pin on upgrade.

A second key `tfCompanion.recentTfvars` holds an MRU of the last 5 pinned paths.

### 2. Resolution keys off the module, not the file's location

```ts
const pinned = this.pins()[moduleDir];
if (!pinned) return files;
return [...files.filter((p) => p !== pinned), pinned];
```

The pin still merges last, still models `-var-file`, and a called module still gets nothing.

### 3. Candidate discovery (pure, in `resolvedHover.ts`)

`tfvarsCandidates(index, moduleDir, roots)` returns a ranked shortlist:

- **module** — `*.tfvars` in `moduleDir`
- **nearby** — `*.tfvars` in any ancestor of `moduleDir` up to a workspace root, plus any
  directory named `env` / `envs` / `vars` / `tfvars` / `environments` that is a child of
  `moduleDir` or of one of those ancestors

That covers the three shapes seen in practice: same directory, a subfolder, and a folder
one or more levels up. Siblings follow for free (a sibling is a child of the parent).

Nearby entries sort by distance (number of `..` segments), then lexically. The list is
capped at 20 with a `truncated` flag.

Labels are paths relative to the module (`../environments/prod.tfvars`), not basenames.
This is what makes 200 same-named files distinguishable without reading absolute paths.

### 4. Quick pick

Grouped with separators: `Automatic`, then `in this module`, `nearby`, `recent`, then
`$(folder-opened) Browse…` with `alwaysShow` so it survives filtering. When truncated, a
row says so and points at Browse.

Two cases that previously lied are now explicit:

- module is called by another module (`externalCallSitesOf().length > 0`) — tfvars do not
  apply there at all, so say it instead of pinning into the void
- no active `.tf` editor — there is no module to attach a pin to, so say that

### 5. Files outside the workspace

`environments/` can sit above the opened root, so Browse must reach outside the index.
`ExternalTfvars` parses such a file on demand, caches the `ParsedFile`, and watches that
single file so edits from outside VS Code are picked up. Watchers are disposed when the
pin goes away.

Browse rejects paths matching `isExcludedTfPath` (`.terraform`, `node_modules`). Pinning
`.terraform/modules/**/prod.tfvars` would otherwise be silently destroyed by the cache
cleaner, which deletes stale `.terraform` folders. The index already excludes those paths,
so only the Browse path needs the guard.

The MRU filters non-existent files at display time, not just when pinning — recents can
point at deleted files for the same reason.

### 6. Status bar

Pins are per-module, so the status bar must follow the active editor:
`onDidChangeActiveTextEditor` → `updateStatusBar()`. It previously updated only on
set/clear, which with a map would show another module's pin.

### 7. Cache cleaner message

Unrelated to the picker, found while auditing deletion safety. `.terraform/terraform.tfstate`
caches the backend configuration, including credentials passed to the CLI. A module
initialised with `terraform init -backend-config=...` needs those flags again after the
folder is deleted; a bare `init` prompts or fails. The confirmation message claims
`terraform init` recreates everything, which is incomplete for partial backend config.
Add that caveat.

## Testing

`test/fixtures/envlayout/` — `infra/main.tf` plus `environments/{dev,prod}.tfvars` — covers
the central-vars layout that had no coverage. Unit tests for discovery, ordering, relative
labels, the exclusion guard, and the state migration.

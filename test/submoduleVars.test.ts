import { beforeAll, describe, expect, it } from 'vitest';
import { type EvalScope, emptyUsage, resolveRef, UNKNOWN } from '../src/core/evaluator';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { computeHover } from '../src/features/resolvedHover';
import { initTestParser, tfvarsIn } from './helpers';

const ROOT_MAIN = `module "app" {
  source = "./modules/app"
  env    = local.env_name
  name   = "fixed-name"
}
`;
const ROOT_VARIABLES = `variable "environment" {
  default = "dev"
}
`;
const ROOT_LOCALS = `locals {
  env_name = var.environment
}
`;
const APP_VARIABLES = `variable "env" {
  type = string
}

variable "name" {
  default = "app"
}

variable "size" {
  default = "small"
}

variable "environment" {
  default = "sub-default"
}
`;
const APP_LOCALS = `locals {
  prefix = "\${var.name}-\${var.env}"
}
`;
const APP_MAIN = `module "db" {
  source = "./modules/db"
  db_env = var.env
}
`;
const DB_VARIABLES = `variable "db_env" {
  type = string
}
`;

async function buildIndex(files: Record<string, string>): Promise<WorkspaceIndex> {
  return WorkspaceIndex.build({
    listFiles: async () => Object.keys(files),
    readFile: async (p) => files[p] ?? '',
  });
}

let index: WorkspaceIndex;

beforeAll(async () => {
  await initTestParser();
  index = await buildIndex({
    '/root/main.tf': ROOT_MAIN,
    '/root/variables.tf': ROOT_VARIABLES,
    '/root/locals.tf': ROOT_LOCALS,
    '/root/modules/app/variables.tf': APP_VARIABLES,
    '/root/modules/app/locals.tf': APP_LOCALS,
    '/root/modules/app/main.tf': APP_MAIN,
    '/root/modules/app/modules/db/variables.tf': DB_VARIABLES,
    '/other/variables.tf': 'variable "environment" {\n  default = "other-default"\n}\n',
  });
});

function appScope(overrides?: Partial<EvalScope>): EvalScope {
  return {
    index,
    moduleDir: '/root/modules/app',
    tfvarsOf: tfvarsIn('/root', { environment: '"prod"' }),
    used: emptyUsage(),
    ...overrides,
  };
}

/** What the hover renders for a divergence: the WHOLE target resolved once
 *  per call site. The evaluator reports where instances split, not the
 *  values of the var that split them — an expression wrapping that var
 *  ("app-${var.env}") has to be evaluated per instance to report honestly. */
function perInstance(target: string[], scope: EvalScope): [string, string][] {
  const d = scope.used?.divergedAt;
  if (!d) return [];
  return d.sites.map((site, i) => [
    d.labels[i] ?? '?',
    resolveRef(target, {
      ...scope,
      used: emptyUsage(),
      pinnedSites: new Map([[d.moduleDir, site]]),
    }),
  ]);
}

describe('F7 vars across module calls', () => {
  it('finds the call sites of a module directory', () => {
    const sites = index.callSitesOf('/root/modules/app');
    expect(sites).toHaveLength(1);
    expect(sites[0]?.callerDir).toBe('/root');
    expect(sites[0]?.file).toBe('/root/main.tf');
  });

  it('resolves a submodule var through call site → caller local → var → tfvars', () => {
    const scope = appScope();
    expect(resolveRef(['var', 'env'], scope)).toBe('prod');
    expect([...(scope.used?.tfvars ?? [])]).toEqual(['environment']);
    expect([...(scope.used?.calls ?? [])]).toEqual(['module "app" (main.tf)']);
  });

  it('the value passed at the call site beats the submodule default', () => {
    expect(resolveRef(['var', 'name'], appScope())).toBe('fixed-name');
  });

  it('falls back to the submodule default when the call site does not pass the var', () => {
    const scope = appScope();
    expect(resolveRef(['var', 'size'], scope)).toBe('small');
    expect([...(scope.used?.defaults.entries() ?? [])]).toEqual([
      ['size', '/root/modules/app/variables.tf'],
    ]);
  });

  it('does NOT leak root tfvars into a submodule var with the same name', () => {
    // root tfvars sets environment = "prod", but the submodule's own
    // variable "environment" is not passed in the call → its default wins
    expect(resolveRef(['var', 'environment'], appScope())).toBe('sub-default');
  });

  it('resolves a submodule local through the var passed at the call site', () => {
    expect(resolveRef(['local', 'prefix'], appScope())).toBe('fixed-name-prod');
  });

  it('follows nested module chains up to the root, recording the call path root → leaf', () => {
    const scope = appScope({ moduleDir: '/root/modules/app/modules/db' });
    expect(resolveRef(['var', 'db_env'], scope)).toBe('prod');
    expect([...(scope.used?.calls ?? [])]).toEqual([
      'module "app" (main.tf)',
      'module "db" (main.tf)',
    ]);
  });

  it('ignores the tfvars of a different root directory', () => {
    // the tfvars belong to /root; /other is its own root with the same var name,
    // so its default must win over the /root tfvars value
    const other = appScope({ moduleDir: '/other' });
    expect(resolveRef(['var', 'environment'], other)).toBe('other-default');
  });

  it('each root module reads its own tfvars', () => {
    // the bug this replaces: one globally chosen tfvars became THE root, and
    // every other root module silently fell back to its defaults
    const scope = appScope({
      moduleDir: '/other',
      tfvarsOf: tfvarsIn('/other', { environment: '"from-other"' }, '/other/terraform.tfvars'),
      used: emptyUsage(),
    });
    expect(resolveRef(['var', 'environment'], scope)).toBe('from-other');
    expect([...(scope.used?.tfvarsFiles ?? [])]).toEqual(['/other/terraform.tfvars']);
  });
});

describe('F7 multiple call sites', () => {
  it('agreeing instances resolve to the shared value', async () => {
    const idx = await buildIndex({
      '/c/main.tf': `module "a" {
  source = "./m"
  env    = "same"
}
module "b" {
  source = "./m"
  env    = "same"
}
`,
      '/c/m/variables.tf': 'variable "env" {\n  type = string\n}\n',
    });
    const scope: EvalScope = {
      index: idx,
      moduleDir: '/c/m',
      used: emptyUsage(),
    };
    expect(resolveRef(['var', 'env'], scope)).toBe('same');
    expect(scope.used?.divergedAt).toBeUndefined();
    // agreeing sibling instances are grouped into one provenance entry (not a chain)
    expect([...(scope.used?.calls ?? [])]).toEqual(['module "a" (main.tf), module "b" (main.tf)']);
  });

  it('an instance that omits the var competes with its default value', async () => {
    const idx = await buildIndex({
      '/c/main.tf': `module "a" {
  source = "./m"
  env    = "one"
}
module "b" {
  source = "./m"
}
`,
      '/c/m/variables.tf': 'variable "env" {\n  default = "fallback"\n}\n',
    });
    const scope: EvalScope = {
      index: idx,
      moduleDir: '/c/m',
      used: emptyUsage(),
    };
    expect(resolveRef(['var', 'env'], scope)).toBe(UNKNOWN);
    expect(perInstance(['var', 'env'], scope)).toEqual([
      ['module "a" (main.tf)', 'one'],
      ['module "b" (main.tf)', 'fallback'],
    ]);
  });

  it('keeps one conflict row per instance when call-site files share a basename', async () => {
    // canonical layout: envs/dev/main.tf and envs/prod/main.tf both call the
    // module with the same label — labels must grow until they are distinct
    const idx = await buildIndex({
      '/ws/envs/dev/main.tf': `module "net" {\n  source = "../../modules/net"\n  env    = "dev"\n}\n`,
      '/ws/envs/prod/main.tf': `module "net" {\n  source = "../../modules/net"\n  env    = "prod"\n}\n`,
      '/ws/modules/net/variables.tf': 'variable "env" {\n  type = string\n}\n',
    });
    const scope: EvalScope = {
      index: idx,
      moduleDir: '/ws/modules/net',
      used: emptyUsage(),
    };
    expect(resolveRef(['var', 'env'], scope)).toBe(UNKNOWN);
    expect(perInstance(['var', 'env'], scope)).toEqual([
      ['module "net" (dev/main.tf)', 'dev'],
      ['module "net" (prod/main.tf)', 'prod'],
    ]);
  });

  it('disagreeing instances render unknown and report one value per instance', async () => {
    const idx = await buildIndex({
      '/c/main.tf': `module "a" {
  source = "./m"
  env    = "one"
}
module "b" {
  source = "./m"
  env    = "two"
}
`,
      '/c/m/variables.tf': 'variable "env" {\n  type = string\n}\n',
    });
    const scope: EvalScope = {
      index: idx,
      moduleDir: '/c/m',
      used: emptyUsage(),
    };
    expect(resolveRef(['var', 'env'], scope)).toBe(UNKNOWN);
    expect(perInstance(['var', 'env'], scope)).toEqual([
      ['module "a" (main.tf)', 'one'],
      ['module "b" (main.tf)', 'two'],
    ]);
  });
});

describe('F7 edge cases', () => {
  it('caps recursion on cyclic module calls', async () => {
    const idx = await buildIndex({
      '/x/a/main.tf': 'module "b" {\n  source = "../b"\n  v = var.v\n}\nvariable "v" {}\n',
      '/x/b/main.tf': 'module "a" {\n  source = "../a"\n  v = var.v\n}\nvariable "v" {}\n',
    });
    const scope: EvalScope = { index: idx, moduleDir: '/x/a' };
    expect(resolveRef(['var', 'v'], scope)).toBe(UNKNOWN);
  });

  it('ignores call sites living inside the module own tree (examples/)', async () => {
    const idx = await buildIndex({
      '/r/variables.tf': 'variable "env" {\n  default = "dev"\n}\n',
      '/r/examples/main.tf': 'module "ex" {\n  source = "../"\n  env = "example"\n}\n',
    });
    // no tfvars anywhere; the examples/ call must not
    // hijack the root module's own default
    const scope: EvalScope = { index: idx, moduleDir: '/r' };
    expect(resolveRef(['var', 'env'], scope)).toBe('dev');
  });

  it('a root that is also instantiated elsewhere still resolves from its own tfvars', async () => {
    const idx = await buildIndex({
      '/r/variables.tf': 'variable "env" {\n  default = "dev"\n}\n',
      '/r/examples/main.tf': 'module "ex" {\n  source = "../"\n  env = "example"\n}\n',
    });
    const scope: EvalScope = {
      index: idx,
      moduleDir: '/r',
      tfvarsOf: tfvarsIn('/r', { env: '"from-tfvars"' }),
    };
    expect(resolveRef(['var', 'env'], scope)).toBe('from-tfvars');
  });
});

describe('F7 a divergence reports the hovered expression, not the var that split it', () => {
  /** modules/app is instantiated twice with different env; region agrees. */
  const workspace = {
    '/ws/envs/dev/main.tf': `module "app" {
  source = "../../modules/app"
  env    = "dev"
  region = "eu-west-1"
}
`,
    '/ws/envs/prod/main.tf': `module "app" {
  source = "../../modules/app"
  env    = "prod"
  region = "eu-west-1"
}
`,
    '/ws/modules/app/main.tf': `variable "env" {}
variable "region" {}
locals {
  name  = "app-\${var.env}"
  twice = "\${var.env}-\${var.env}"
  combo = "\${var.env}-\${var.region}"
  fixed = "constant"
}
`,
  };

  /** The hover body for a local defined in modules/app. */
  async function hoverLocal(name: string): Promise<string | undefined> {
    const idx = await buildIndex(workspace);
    const file = idx.file('/ws/modules/app/main.tf');
    if (!file) throw new Error('fixture not indexed');
    const attr = file.blocks
      .filter((b) => b.kind === 'locals')
      .flatMap((b) => b.attrs)
      .find((a) => a.name === name);
    if (!attr) throw new Error(`local ${name} not found`);
    return computeHover(file, attr.span.start, {
      index: idx,
      tfvarsOf: () => new Map(),
      copyCommand: 'copy',
    });
  }

  it('resolves the whole expression once per instance', async () => {
    // recording the divergent var's own values here produced dev/prod — the
    // "app-" prefix vanished and the rows misclaimed to be local.name's values
    const body = await hoverLocal('name');
    expect(body).toContain('**local.name** differs per module instance');
    expect(body).toContain('`app-dev`');
    expect(body).toContain('`app-prod`');
    expect(body).not.toMatch(/`dev`/);
  });

  it('substitutes the divergent var at every occurrence', async () => {
    const body = await hoverLocal('twice');
    expect(body).toContain('`dev-dev`');
    expect(body).toContain('`prod-prod`');
  });

  it('keeps the parts of the expression that do NOT diverge', async () => {
    // the region half used to be dropped entirely from the reported value
    const body = await hoverLocal('combo');
    expect(body).toContain('`dev-eu-west-1`');
    expect(body).toContain('`prod-eu-west-1`');
  });

  it('reports a single value when the divergent var never reaches it', async () => {
    const body = await hoverLocal('fixed');
    expect(body).toContain('**local.fixed** = `constant`');
    expect(body).not.toContain('differs per module instance');
  });
});

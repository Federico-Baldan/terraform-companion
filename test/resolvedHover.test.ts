import { beforeAll, describe, expect, it } from 'vitest';
import { type EvalScope, emptyUsage, resolveRef, UNKNOWN } from '../src/core/evaluator';
import { parseFile } from '../src/core/parser';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import {
  autoLoadedTfvars,
  computeHover,
  definitionAt,
  hoverMarkdown,
  tfvarsValues,
} from '../src/features/resolvedHover';
import { initTestParser, tfvarsIn } from './helpers';

const LOCALS = `locals {
  name_prefix = "\${var.project_name}-\${var.environment}"
}
`;
const VARIABLES = `variable "project_name" {
  default = "satispay"
}

variable "environment" {
  default = "dev"
}
`;

let index: WorkspaceIndex;

beforeAll(async () => {
  await initTestParser();
  const files: Record<string, string> = {
    '/mod/locals.tf': LOCALS,
    '/mod/variables.tf': VARIABLES,
  };
  index = await WorkspaceIndex.build({
    listFiles: async () => Object.keys(files),
    readFile: async (p) => files[p] ?? '',
  });
});

describe('F7 hover sulla definizione', () => {
  it('finds a local definition by its name under the cursor', () => {
    const file = parseFile('/mod/locals.tf', LOCALS);
    expect(definitionAt(file, { row: 1, column: 4 })).toEqual({
      kind: 'local',
      name: 'name_prefix',
    });
    // on the value, not the name → not a definition hit
    expect(definitionAt(file, { row: 1, column: 20 })).toBeUndefined();
  });

  it('finds a variable definition on its name, not the rest of the header line', () => {
    const file = parseFile('/mod/variables.tf', VARIABLES);
    expect(definitionAt(file, { row: 0, column: 12 })).toEqual({
      kind: 'var',
      name: 'project_name',
    });
    // on the opening brace, past the label → not a definition hit
    expect(definitionAt(file, { row: 0, column: 24 })).toBeUndefined();
  });

  it('resolves the full value of the definition through the var chain', () => {
    const scope: EvalScope = { index, moduleDir: '/mod' };
    expect(resolveRef(['local', 'name_prefix'], scope)).toBe('satispay-dev');
  });

  it('tracks whether each var came from tfvars or from the default, with the real file', () => {
    const used = emptyUsage();
    const scope: EvalScope = {
      index,
      moduleDir: '/mod',
      tfvarsOf: tfvarsIn('/mod', { project_name: '"prod-name"' }, '/mod/terraform.tfvars'),
      used,
    };
    expect(resolveRef(['local', 'name_prefix'], scope)).toBe('prod-name-dev');
    expect([...used.tfvars]).toEqual(['project_name']);
    expect([...used.tfvarsFiles]).toEqual(['/mod/terraform.tfvars']);
    expect([...used.defaults.entries()]).toEqual([['environment', '/mod/variables.tf']]);
  });
});

describe('F7 hover markdown', () => {
  const copyCommand = 'tfCompanion.copyValue';

  it('shows value, real provenance and a copy link', () => {
    const used = emptyUsage();
    used.tfvars.add('project_name');
    used.tfvarsFiles.add('/mod/prod.tfvars');
    used.defaults.set('environment', '/mod/variables.tf');
    const md = hoverMarkdown({
      target: ['local', 'name_prefix'],
      value: 'prod-name-dev',
      used,
      copyCommand,
    });
    expect(md).toContain('**local.name_prefix** = `prod-name-dev`');
    expect(md).toContain('_(from prod.tfvars + default in variables.tf)_');
    expect(md).toContain(
      `[Copy value](command:${copyCommand}?${encodeURIComponent(JSON.stringify(['prod-name-dev']))})`,
    );
  });

  it('shows the module-call chain when the value travels through call sites', () => {
    const used = emptyUsage();
    used.tfvars.add('environment');
    used.tfvarsFiles.add('/mod/terraform.tfvars');
    used.calls.add('module "app" (main.tf)');
    used.calls.add('module "db" (app.tf)');
    const md = hoverMarkdown({
      target: ['var', 'db_env'],
      value: 'prod',
      used,
      copyCommand,
    });
    expect(md).toContain(
      '_(from terraform.tfvars + via module "app" (main.tf) → module "db" (app.tf))_',
    );
  });

  it('lists one value per instance when module calls disagree', () => {
    const used = emptyUsage();
    used.conflicts.set('module "a" (main.tf)', 'one');
    used.conflicts.set('module "b" (main.tf)', 'two');
    const md = hoverMarkdown({ target: ['var', 'env'], value: UNKNOWN, used, copyCommand });
    expect(md).toContain('**var.env** differs per module instance:');
    expect(md).toContain('- module "a" (main.tf): `one`');
    expect(md).toContain('- module "b" (main.tf): `two`');
    expect(md).toContain(encodeURIComponent(JSON.stringify(['two'])));
  });

  it('escapes markdown-active characters in labels and file names', () => {
    const used = emptyUsage();
    used.conflicts.set('module "a" ([evil].tf)', 'one');
    const md = hoverMarkdown({ target: ['var', 'env'], value: UNKNOWN, used, copyCommand });
    // brackets escaped → the label cannot become link text for an injected link
    expect(md).toContain('- module "a" (\\[evil\\].tf): `one`');

    const viaUsed = emptyUsage();
    viaUsed.tfvars.add('env');
    viaUsed.tfvarsFiles.add('/mod/_dev_.tfvars');
    viaUsed.calls.add('module "x" (my_mod.tf)');
    const viaMd = hoverMarkdown({
      target: ['var', 'env'],
      value: 'v',
      used: viaUsed,
      copyCommand,
    });
    expect(viaMd).toContain('from \\_dev\\_.tfvars');
    expect(viaMd).toContain('via module "x" (my\\_mod.tf)');
  });

  it('renders a value containing a backtick without breaking out of the code span', () => {
    const md = hoverMarkdown({
      target: ['var', 'x'],
      value: 'a`b',
      used: emptyUsage(),
      copyCommand,
    });
    // fence widened to two backticks so the inner one cannot close the span
    expect(md).toContain('``a`b``');
  });

  it('explains an unknown var with no provenance', () => {
    const md = hoverMarkdown({
      target: ['var', 'region'],
      value: UNKNOWN,
      used: emptyUsage(),
      tfvarsNames: ['dev.tfvars'],
      copyCommand,
    });
    expect(md).toContain('_(no value: not set in dev.tfvars and no default)_');
  });
});

/** The hover used to truncate the reference under the cursor to its first
 *  two parts, so local.cfg.db.host reported the whole local.cfg object (and,
 *  since objects didn't evaluate, reported it as unknown). */
describe('hover on an attribute path', () => {
  const copyCommand = 'tfCompanion.copyValue';
  let objIndex: WorkspaceIndex;
  const path = '/obj/main.tf';
  const src = `locals {
  cfg = {
    name = "app-\${var.environment}"
    db   = { host = "db.internal", port = 5432 }
  }
}

resource "aws_db_instance" "d" {
  host = local.cfg.db.host
  name = local.cfg.name
  all  = local.cfg
}
`;

  beforeAll(async () => {
    const files: Record<string, string> = { [path]: src, '/obj/variables.tf': VARIABLES };
    objIndex = await WorkspaceIndex.build({
      listFiles: async () => Object.keys(files),
      readFile: async (p) => files[p] ?? '',
    });
  });

  const hoverAt = (parts: string[]) => {
    const file = objIndex.file(path);
    if (!file) throw new Error('fixture not indexed');
    const ref = file.refs.find((r) => r.parts.join('.') === parts.join('.'));
    if (!ref) throw new Error(`no reference to ${parts.join('.')}`);
    return computeHover(file, ref.span.start, {
      index: objIndex,
      tfvarsOf: () => new Map(),
      copyCommand,
    });
  };

  it('reads a nested field rather than the enclosing object', () => {
    expect(hoverAt(['local', 'cfg', 'db', 'host'])).toContain(
      '**local.cfg.db.host** = `db.internal`',
    );
  });

  it('resolves a field that itself interpolates a var', () => {
    expect(hoverAt(['local', 'cfg', 'name'])).toContain('**local.cfg.name** = `app-dev`');
  });

  it('still renders the whole object when that is what is hovered', () => {
    const md = hoverAt(['local', 'cfg']);
    expect(md).toContain('name = app-dev');
    expect(md).toContain('host = db.internal');
  });
});

describe('copy link escaping', () => {
  it('escapes parentheses so the markdown link is not cut short', () => {
    // encodeURIComponent leaves ( and ) alone, and an unescaped ) closes the
    // link — the copy command got a truncated value and the tail leaked into
    // the hover as plain text
    const md = hoverMarkdown({
      target: ['local', 'cidr'],
      value: 'cidr(10.0.0.0/8)',
      used: emptyUsage(),
      copyCommand: 'tfCompanion.copyValue',
    });
    const link = md.slice(md.indexOf('[Copy value]'));
    expect(link).not.toMatch(/\((?!command:)/);
    expect(link).toContain('%28');
    expect(link).toContain('%29');
    // exactly one closing paren: the one that ends the link
    expect(link.match(/\)/g)).toHaveLength(1);
  });
});

/** The multi-env layout the hover used to get wrong: one tfvars was chosen
 *  for the whole workspace, so every OTHER root module silently fell back to
 *  its defaults — and said "default in variables.tf" as if that were the answer. */
describe('each root module reads its own tfvars', () => {
  const workspace: Record<string, string> = {
    '/ws/envs/dev/variables.tf': 'variable "region" {\n  default = "us-east-1"\n}\n',
    '/ws/envs/dev/main.tf': 'output "o" {\n  value = var.region\n}\n',
    '/ws/envs/dev/terraform.tfvars': 'region = "eu-dev-1"\n',
    '/ws/envs/prod/variables.tf': 'variable "region" {\n  default = "us-east-1"\n}\n',
    '/ws/envs/prod/main.tf': 'output "o" {\n  value = var.region\n}\n',
    '/ws/envs/prod/terraform.tfvars': 'region = "eu-prod-1"\n',
    '/ws/envs/prod/z.auto.tfvars': 'zone = "z-prod"\n',
  };
  let envIndex: WorkspaceIndex;

  beforeAll(async () => {
    envIndex = await WorkspaceIndex.build({
      listFiles: async () => Object.keys(workspace),
      readFile: async (p) => workspace[p] ?? '',
    });
  });

  /** what ActiveTfvars.valuesFor does, without the VS Code context */
  const valuesFor = (dir: string) => {
    const merged = new Map<string, { text: string; file: string }>();
    for (const p of autoLoadedTfvars(envIndex, dir)) {
      for (const [k, v] of tfvarsValues(envIndex.file(p))) merged.set(k, v);
    }
    return merged;
  };

  it('auto-loads terraform.tfvars before *.auto.tfvars, per directory', () => {
    expect(autoLoadedTfvars(envIndex, '/ws/envs/prod')).toEqual([
      '/ws/envs/prod/terraform.tfvars',
      '/ws/envs/prod/z.auto.tfvars',
    ]);
    expect(autoLoadedTfvars(envIndex, '/ws/envs/dev')).toEqual(['/ws/envs/dev/terraform.tfvars']);
  });

  it('resolves prod from prod tfvars and dev from dev tfvars', () => {
    for (const env of ['dev', 'prod']) {
      const dir = `/ws/envs/${env}`;
      const used = emptyUsage();
      const value = resolveRef(['var', 'region'], {
        index: envIndex,
        moduleDir: dir,
        tfvarsOf: valuesFor,
        used,
      });
      expect(value).toBe(`eu-${env}-1`);
      expect([...used.tfvarsFiles]).toEqual([`${dir}/terraform.tfvars`]);
      // never the default, and never the other environment's file
      expect(used.defaults.size).toBe(0);
    }
  });

  it('names the file the value really came from', () => {
    const body = computeHover(
      parseFile('/ws/envs/prod/main.tf', workspace['/ws/envs/prod/main.tf'] ?? ''),
      { row: 1, column: 14 },
      { index: envIndex, tfvarsOf: valuesFor, copyCommand: 'c' },
    );
    expect(body).toContain('**var.region** = `eu-prod-1`');
    expect(body).toContain('from terraform.tfvars');
  });
});

describe('multi-line values in the hover body', () => {
  beforeAll(initTestParser);

  const noProvenance = () => emptyUsage();

  it('keeps a blank line from breaking out of the code span', () => {
    // "Welcome\n\nPlease log out" is the ordinary shape of a banner or policy
    // doc; a blank line ends the paragraph, so a verbatim code span closed
    // early and spilled its tail into the hover as markdown
    const body = hoverMarkdown({
      target: ['local', 'motd'],
      value: 'Welcome\n\nPlease log out',
      used: noProvenance(),
      copyCommand: 'c',
    });
    expect(body).toContain('**local.motd** = `Welcome\\n\\nPlease log out`');
    // the rendered body must hold no blank line inside a code span
    expect(/`[^`]*\n\s*\n[^`]*`/.test(body)).toBe(false);
  });

  it('shows a single newline instead of silently rendering it as a space', () => {
    const body = hoverMarkdown({
      target: ['local', 'two'],
      value: 'a\nb',
      used: noProvenance(),
      copyCommand: 'c',
    });
    expect(body).toContain('`a\\nb`');
  });

  it('still copies the real bytes, not the escaped spelling', () => {
    const body = hoverMarkdown({
      target: ['local', 'motd'],
      value: 'a\nb',
      used: noProvenance(),
      copyCommand: 'c',
    });
    const arg = body.slice(body.indexOf('command:c?') + 'command:c?'.length, body.lastIndexOf(')'));
    expect(JSON.parse(decodeURIComponent(arg))).toEqual(['a\nb']);
  });

  it('escapes newlines in the per-instance conflict rows too', () => {
    const used = emptyUsage();
    used.conflicts.set('module "app" (dev/main.tf)', 'a\n\nb');
    const body = hoverMarkdown({
      target: ['local', 'name'],
      value: UNKNOWN,
      used,
      copyCommand: 'c',
    });
    expect(body).toContain('`a\\n\\nb`');
    expect(/`[^`]*\n\s*\n[^`]*`/.test(body)).toBe(false);
  });

  it('resolves and renders a multi-line local end to end', async () => {
    const src = 'locals {\n  motd = "Welcome\\n\\nPlease log out"\n}\n';
    const index = await WorkspaceIndex.build({
      listFiles: async () => ['/w/main.tf'],
      readFile: async () => src,
    });
    const body = computeHover(
      parseFile('/w/main.tf', src),
      { row: 1, column: 4 },
      { index, tfvarsOf: () => new Map(), copyCommand: 'c' },
    );
    expect(body).toContain('`Welcome\\n\\nPlease log out`');
  });
});

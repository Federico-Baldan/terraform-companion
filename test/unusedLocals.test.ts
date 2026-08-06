import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { detectUnusedLocals } from '../src/features/unusedLocals';
import { fixturePath, fsHost, initTestParser } from './helpers';

const root = fixturePath('multimod').replace(/\\/g, '/');
let index: WorkspaceIndex;

beforeAll(async () => {
  await initTestParser();
  index = await WorkspaceIndex.build(fsHost(root));
});

describe('F9 unused locals', () => {
  it('flags locals never referenced in their module', () => {
    const findings = detectUnusedLocals(index, root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe('locals.unused');
    expect(findings[0]!.message).toContain('unused_thing');
    expect(findings[0]!.span.start.row).toBe(3); // definition line in locals.tf
    // the warning underlines the name only, not the (possibly multi-line) value
    expect(findings[0]!.span.end).toEqual({ row: 3, column: 2 + 'unused_thing'.length });
  });

  it('does not count a reference from another module directory', async () => {
    await index.updateFile(`${root}/modules/net/uses.tf`, 'locals { x = local.unused_thing }\n');
    const findings = detectUnusedLocals(index, root);
    expect(findings.map((f) => f.message).join(' ')).toContain('unused_thing');
    index.removeFile(`${root}/modules/net/uses.tf`);
  });

  it('counts usage inside another local definition', () => {
    // name_prefix is used by locals.tags and main.tf → not flagged
    const findings = detectUnusedLocals(index, root);
    expect(findings.every((f) => !f.message.includes('name_prefix'))).toBe(true);
  });
});

/** HCL lets whitespace sit anywhere between tokens, so `local. name` parses
 *  cleanly — tree-sitter reports one `get_attr` whose text is ". name". The
 *  strip only ate whitespace *before* the dot, so the part kept its leading
 *  space and matched no local. The lint then offered to delete a local that is
 *  used, which is the expensive direction to be wrong in. */
describe('a reference with whitespace around the dot', () => {
  it('still counts as a use', async () => {
    const path = `${root}/spaced.tf`;
    await index.updateFile(path, 'locals { spaced = 1 }\noutput "o" { value = local. spaced }\n');
    const findings = detectUnusedLocals(index, root);
    expect(findings.map((f) => f.message).join(' ')).not.toContain('spaced');
    index.removeFile(path);
  });
});

/** The other half of the same defect: a comment is its own node, so it either
 *  broke the traversal chain or survived into the part name. Both spellings
 *  made a used local look unused. */
describe('a reference with a comment inside the traversal', () => {
  it('counts a comment before the dot as a use', async () => {
    const path = `${root}/c1.tf`;
    await index.updateFile(path, 'locals { c1 = 1 }\noutput "o" { value = local /*x*/ .c1 }\n');
    const findings = detectUnusedLocals(index, root);
    expect(findings.map((f) => f.message).join(' ')).not.toContain('c1');
    index.removeFile(path);
  });

  it('counts a comment after the dot as a use', async () => {
    const path = `${root}/c2.tf`;
    await index.updateFile(path, 'locals { c2 = 1 }\noutput "o" { value = local. /*x*/ c2 }\n');
    const findings = detectUnusedLocals(index, root);
    expect(findings.map((f) => f.message).join(' ')).not.toContain('c2');
    index.removeFile(path);
  });
});

/** The rule reads an absent reference as proof of disuse, but tree-sitter drops
 *  what it cannot parse — so a sibling mid-edit made every local it alone uses
 *  report as unused, for as long as the user kept typing. */
describe('a sibling that does not parse cannot make a local look unused', () => {
  it('stays quiet while the module is mid-edit, and reports again once it parses', async () => {
    const locals = 'locals {\n  region = "eu-west-1"\n}\n';
    const build = (use: string) =>
      WorkspaceIndex.build({
        listFiles: async () => ['/u/locals.tf', '/u/use.tf'],
        readFile: async (p) => (p === '/u/locals.tf' ? locals : use),
      });

    // local.region really is used, but the unterminated string hides it
    const broken = await build('output "a" {\n  value = "oops\n}\nx = local.region\n');
    expect(broken.file('/u/use.tf')?.hasError).toBe(true);
    expect(detectUnusedLocals(broken, '/u')).toEqual([]);

    // genuinely unused, in a module that parses: still reported
    const clean = await build('output "a" {\n  value = "fine"\n}\n');
    expect(clean.file('/u/use.tf')?.hasError).toBe(false);
    expect(detectUnusedLocals(clean, '/u').map((f) => f.code)).toEqual(['locals.unused']);
  });
});

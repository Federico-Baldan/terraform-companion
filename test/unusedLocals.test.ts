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

import { beforeAll, describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/parser';
import { normalizePath, WorkspaceIndex } from '../src/core/workspaceIndex';
import { detectCountLength, rewriteToForEach } from '../src/features/countForEach';
import { detectRedundantDependsOn } from '../src/features/dependsOn';
import { applyEdits, initTestParser } from './helpers';

beforeAll(initTestParser);

describe('end-to-end on a realistic file', () => {
  it('the depends_on fix applied through real spans re-parses and keeps comments', () => {
    const src = `resource "aws_instance" "web" {
  role       = aws_iam_role.x.name
  subnet_id  = aws_subnet.main.id
  depends_on = [
    /* aws_iam_role.x belongs to the platform team */
    aws_s3_bucket.logs, # not referenced anywhere, must stay
    aws_iam_role.x,
    aws_subnet.main,
  ]
}
`;
    const file = parseFile(normalizePath('/w/main.tf'), src);
    const findings = detectRedundantDependsOn(file);
    expect(findings).toHaveLength(1);
    const fix = findings[0]!.fix!;

    const applied = applyEdits(src.split('\n'), [{ span: fix.span, newText: fix.newText }]);
    // both redundant entries gone, the explicit one and every comment intact
    expect(applied).toBe(`resource "aws_instance" "web" {
  role       = aws_iam_role.x.name
  subnet_id  = aws_subnet.main.id
  depends_on = [
    /* aws_iam_role.x belongs to the platform team */
    aws_s3_bucket.logs, # not referenced anywhere, must stay
  ]
}
`);
    // and the result is still valid HCL with the attribute intact
    const reparsed = parseFile(normalizePath('/w/main.tf'), applied);
    expect(reparsed.blocks[0]!.attrs.map((a) => a.name)).toEqual([
      'role',
      'subnet_id',
      'depends_on',
    ]);
    expect(detectRedundantDependsOn(reparsed)).toEqual([]);
  });

  it('count → for_each is still offered and still correct for a real string list', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile(
      normalizePath('/w/vars.tf'),
      'variable "names" {\n  type = list(string)\n}\n',
    );
    const src = `resource "aws_instance" "srv" {
  count = length(var.names)
  name  = var.names[count.index]
  tag   = upper(var.names[count.index])
}
`;
    const file = parseFile(normalizePath('/w/main.tf'), src);
    const [pattern] = detectCountLength(file, index);
    expect(pattern!.safeToRefactor).toBe(true);
    const applied = applyEdits(file.lines, rewriteToForEach(pattern!));
    expect(applied).toBe(`resource "aws_instance" "srv" {
  for_each = toset(var.names)
  name  = each.value
  tag   = upper(each.value)
}
`);
    // the rewritten block parses and no longer trips the detector
    expect(detectCountLength(parseFile(normalizePath('/w/main.tf'), applied), index)).toEqual([]);
  });
});

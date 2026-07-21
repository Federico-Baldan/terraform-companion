import { beforeAll, describe, expect, it } from 'vitest';
import type { Span } from '../src/core/model';
import { parseFile } from '../src/core/parser';
import { detectRedundantDependsOn } from '../src/features/dependsOn';
import { initTestParser } from './helpers';

beforeAll(async () => {
  await initTestParser();
});

describe('F12 depends_on ridondante', () => {
  it('flags an entry already referenced in the block arguments', () => {
    const src = `resource "aws_instance" "web" {
  subnet_id  = aws_subnet.main.id
  depends_on = [aws_subnet.main]
}
`;
    const findings = detectRedundantDependsOn(parseFile('a.tf', src));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe('dependsOn.redundant');
    expect(findings[0]!.message).toContain('aws_subnet.main');
    // whole attribute removed since every entry is redundant
    expect(findings[0]!.fix).toEqual({
      span: { start: { row: 2, column: 0 }, end: { row: 3, column: 0 } },
      newText: '',
    });
  });

  describe('the delete fix never swallows neighbouring code', () => {
    /** apply a TextEdit the way VS Code would, so the test asserts on real output */
    const apply = (src: string, fix: { span: Span; newText: string }): string => {
      const lines = src.split('\n');
      const { start, end } = fix.span;
      const head = (lines[start.row] ?? '').slice(0, start.column);
      const tail = (lines[end.row] ?? '').slice(end.column);
      lines.splice(start.row, end.row - start.row + 1, head + fix.newText + tail);
      return lines.join('\n');
    };

    it('keeps the closing brace when it shares the depends_on line', () => {
      const src = `resource "aws_instance" "web" { ami = data.aws_ami.x.id
  depends_on = [data.aws_ami.x] }`;
      const fix = detectRedundantDependsOn(parseFile('a.tf', src))[0]!.fix!;
      const out = apply(src, fix);
      expect(out).toContain('}');
      expect(out).not.toContain('depends_on');
      expect(out).toContain('ami = data.aws_ami.x.id');
    });

    it('keeps the block opener when it shares the depends_on line', () => {
      const src = `resource "aws_instance" "web" { depends_on = [data.aws_ami.x]
  ami = data.aws_ami.x.id
}`;
      const fix = detectRedundantDependsOn(parseFile('a.tf', src))[0]!.fix!;
      const out = apply(src, fix);
      expect(out).toContain('resource "aws_instance" "web" {');
      expect(out).not.toContain('depends_on');
    });

    it('still removes the whole line when the attribute owns it', () => {
      const src = `resource "aws_instance" "web" {
  subnet_id  = aws_subnet.main.id
  depends_on = [aws_subnet.main]
}
`;
      const fix = detectRedundantDependsOn(parseFile('a.tf', src))[0]!.fix!;
      expect(apply(src, fix)).toBe(`resource "aws_instance" "web" {
  subnet_id  = aws_subnet.main.id
}
`);
    });
  });

  // depends_on accepts instance addresses (aws_subnet.main[0]), and the bare
  // address is a prefix of the indexed one — the fix used to match
  // aws_subnet.main *inside* the indexed entry and splice it apart, leaving
  // corrupt HCL like [[0], aws_subnet.main]
  it('never splices inside a longer indexed entry of the same resource', () => {
    const src = `resource "aws_instance" "web" {
  ids        = aws_subnet.main[*].id
  depends_on = [aws_subnet.main[0], aws_subnet.main]
}
`;
    const findings = detectRedundantDependsOn(parseFile('a.tf', src));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('aws_subnet.main');
    expect(findings[0]!.fix?.newText).toBe('[aws_subnet.main[0]]');
  });

  it('keeps genuinely explicit dependencies in the fix', () => {
    const src = `resource "aws_instance" "web" {
  subnet_id  = aws_subnet.main.id
  depends_on = [aws_subnet.main, aws_iam_role.other]
}
`;
    const findings = detectRedundantDependsOn(parseFile('b.tf', src));
    expect(findings).toHaveLength(1);
    // only the tuple is rewritten, by editing its own text — the attribute
    // name and spacing around = are none of the fix's business
    expect(findings[0]!.fix?.newText).toBe('[aws_iam_role.other]');
  });

  it('does not flag purely explicit dependencies', () => {
    const src = `resource "aws_instance" "web" {
  ami        = "ami-123"
  depends_on = [aws_iam_role.other]
}
`;
    expect(detectRedundantDependsOn(parseFile('c.tf', src))).toEqual([]);
  });

  it('flags data addresses but never module addresses', () => {
    const src = `resource "aws_instance" "web" {
  subnet_id  = module.net.subnet_id
  user_data  = data.aws_ami.ubuntu.id
  depends_on = [module.net, data.aws_ami.ubuntu]
}
`;
    const findings = detectRedundantDependsOn(parseFile('d.tf', src));
    expect(findings).toHaveLength(1);
    // depends_on = [module.net] waits for the WHOLE module, a reference to one
    // output does not: not equivalent, so module entries must survive the fix
    expect(findings[0]!.message).not.toContain('module.net');
    expect(findings[0]!.message).toContain('data.aws_ami.ubuntu');
    expect(findings[0]!.fix?.newText).toBe('[module.net]');
  });

  it('ignores the refs inside the depends_on tuple itself', () => {
    const src = `resource "aws_instance" "web" {
  ami        = "ami-123"
  depends_on = [aws_subnet.main]
}
`;
    expect(detectRedundantDependsOn(parseFile('e.tf', src))).toEqual([]);
  });

  it('drops comments inside the tuple instead of treating them as entries', () => {
    const src = `resource "aws_instance" "web" {
  subnet_id  = aws_subnet.main.id
  depends_on = [
    aws_subnet.main, # ensure subnet first
  ]
}
`;
    const findings = detectRedundantDependsOn(parseFile('f.tf', src));
    expect(findings).toHaveLength(1);
    // the comment is not an entry: every real entry is redundant, attribute deleted
    expect(findings[0]!.fix).toEqual({
      span: { start: { row: 2, column: 0 }, end: { row: 5, column: 0 } },
      newText: '',
    });
  });

  it('keeps explicit entries from a multi-line tuple with mixed comments', () => {
    const src = `resource "aws_instance" "web" {
  subnet_id  = aws_subnet.main.id
  depends_on = [
    aws_subnet.main,    // implicit
    aws_iam_role.other, /* explicit */
  ]
}
`;
    const findings = detectRedundantDependsOn(parseFile('g.tf', src));
    expect(findings).toHaveLength(1);
    // the tuple keeps its layout and the comment on the surviving entry;
    // only the redundant entry and its trailing comment go. Rebuilding from
    // the parsed entries would flatten all of this
    expect(findings[0]!.fix?.newText).toBe(`[
    aws_iam_role.other, /* explicit */
  ]`);
  });

  /** The entry list is parsed with comments stripped, but the fix splices
   *  raw tuple text. An address also appearing in a comment used to have two
   *  candidate matches, and the first one won — cutting words out of the
   *  comment and leaving the real entry in place. */
  describe('an address mentioned in a comment is not mistaken for the entry', () => {
    it('line comment on an earlier entry', () => {
      const src = `resource "aws_instance" "web" {
  role       = aws_iam_role.x.name
  depends_on = [
    aws_s3_bucket.b, # must exist before aws_iam_role.x
    aws_iam_role.x,
  ]
}
`;
      const findings = detectRedundantDependsOn(parseFile('h.tf', src));
      expect(findings).toHaveLength(1);
      expect(findings[0]!.fix?.newText).toBe(`[
    aws_s3_bucket.b, # must exist before aws_iam_role.x
  ]`);
    });

    it('block comment before the entries', () => {
      const src = `resource "aws_instance" "web" {
  role       = aws_iam_role.x.name
  depends_on = [
    /* aws_iam_role.x is created by the platform team */
    aws_s3_bucket.b,
    aws_iam_role.x,
  ]
}
`;
      const findings = detectRedundantDependsOn(parseFile('i.tf', src));
      expect(findings).toHaveLength(1);
      expect(findings[0]!.fix?.newText).toBe(`[
    /* aws_iam_role.x is created by the platform team */
    aws_s3_bucket.b,
  ]`);
    });
  });
});

describe('an indexed reference does not make a bare depends_on redundant', () => {
  // Terraform folds the index into the reference's subject, so b[0].id
  // depends on instance 0 alone while depends_on = [b] waits for all of
  // them. Removing it there narrows the graph edge and lets the block build
  // before the rest of count exists
  it('keeps depends_on when the only reference is indexed by a literal', () => {
    const src = `resource "aws_instance" "web" {
  bucket     = aws_s3_bucket.b[0].id
  depends_on = [aws_s3_bucket.b]
}
`;
    expect(detectRedundantDependsOn(parseFile('a.tf', src))).toEqual([]);
  });

  it('keeps depends_on when the reference is indexed by count.index', () => {
    const src = `resource "aws_instance" "web" {
  count      = 3
  bucket     = aws_s3_bucket.b[count.index].id
  depends_on = [aws_s3_bucket.b]
}
`;
    expect(detectRedundantDependsOn(parseFile('a.tf', src))).toEqual([]);
  });

  it('keeps depends_on for a for_each key reference', () => {
    const src = `resource "aws_instance" "web" {
  bucket     = aws_s3_bucket.b["primary"].id
  depends_on = [aws_s3_bucket.b]
}
`;
    expect(detectRedundantDependsOn(parseFile('a.tf', src))).toEqual([]);
  });

  it('still flags a splat, which reads every instance', () => {
    const src = `resource "aws_instance" "web" {
  buckets    = aws_s3_bucket.b[*].id
  depends_on = [aws_s3_bucket.b]
}
`;
    const findings = detectRedundantDependsOn(parseFile('a.tf', src));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('aws_s3_bucket.b');
  });

  it('flags it when an unindexed reference sits alongside the indexed one', () => {
    const src = `resource "aws_instance" "web" {
  first      = aws_s3_bucket.b[0].id
  all        = aws_s3_bucket.b
  depends_on = [aws_s3_bucket.b]
}
`;
    expect(detectRedundantDependsOn(parseFile('a.tf', src))).toHaveLength(1);
  });

  it('only spares the indexed entry, not its unindexed neighbour', () => {
    const src = `resource "aws_instance" "web" {
  bucket     = aws_s3_bucket.b[0].id
  role       = aws_iam_role.r.name
  depends_on = [aws_s3_bucket.b, aws_iam_role.r]
}
`;
    const findings = detectRedundantDependsOn(parseFile('a.tf', src));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('aws_iam_role.r');
    expect(findings[0]!.message).not.toContain('aws_s3_bucket.b');
    expect(findings[0]!.fix!.newText).toBe('[aws_s3_bucket.b]');
  });
});

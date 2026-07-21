import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/parser';
import { detectVersionHygiene } from '../src/features/versionHygiene';
import { fixturePath, initTestParser } from './helpers';

beforeAll(async () => {
  await initTestParser();
});

describe('F11 version hygiene', () => {
  it('flags registry modules without a version pin', () => {
    const file = parseFile('main.tf', readFileSync(fixturePath('multimod', 'main.tf'), 'utf8'));
    const findings = detectVersionHygiene(file, { variableDocs: false });
    expect(findings.map((f) => f.code)).toEqual(['hygiene.moduleUnpinned']);
    expect(findings[0]!.message).toContain('unpinned');
  });

  it('flags unbounded >= constraints but accepts bounded ones', () => {
    const mk = (constraint: string) =>
      `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "${constraint}"\n    }\n  }\n}\n`;
    const findings = detectVersionHygiene(parseFile('a.tf', mk('>= 5.0')), { variableDocs: false });
    expect(findings.map((f) => f.code)).toEqual(['hygiene.unboundedConstraint']);
    expect(findings[0]!.message).toContain('major provider update');
    expect(detectVersionHygiene(parseFile('b.tf', mk('~> 5.0')), { variableDocs: false })).toEqual(
      [],
    );
    expect(
      detectVersionHygiene(parseFile('c.tf', mk('>= 4.0, < 6')), { variableDocs: false }),
    ).toEqual([]);
  });

  it('flags a single-segment ~> as unbounded — go-version caps nothing on it', () => {
    const mk = (constraint: string) =>
      `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "${constraint}"\n    }\n  }\n}\n`;
    const findings = detectVersionHygiene(parseFile('s.tf', mk('~> 5')), { variableDocs: false });
    expect(findings.map((f) => f.code)).toEqual(['hygiene.unboundedConstraint']);
    // the message must not suggest "~>" back at someone already using it
    expect(findings[0]!.message).toContain('"~> 5.0"');
    expect(detectVersionHygiene(parseFile('t.tf', mk('~> 5.0')), { variableDocs: false })).toEqual(
      [],
    );
  });

  it('flags unbounded constraints in the legacy string form too', () => {
    const src = 'terraform {\n  required_providers {\n    aws = ">= 5.0"\n  }\n}\n';
    const findings = detectVersionHygiene(parseFile('l.tf', src), { variableDocs: false });
    expect(findings.map((f) => f.code)).toEqual(['hygiene.unboundedConstraint']);
  });

  it('flags unbounded constraints on registry module versions too', () => {
    const mk = (constraint: string) =>
      `module "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "${constraint}"\n}\n`;
    const findings = detectVersionHygiene(parseFile('m.tf', mk('>= 3.0')), { variableDocs: false });
    expect(findings.map((f) => f.code)).toEqual(['hygiene.unboundedConstraint']);
    expect(findings[0]!.message).toContain('major module update');
    expect(detectVersionHygiene(parseFile('n.tf', mk('~> 3.0')), { variableDocs: false })).toEqual(
      [],
    );
    expect(detectVersionHygiene(parseFile('o.tf', mk('3.0.0')), { variableDocs: false })).toEqual(
      [],
    );
  });

  it('flags variables missing description or type only when enabled', () => {
    const file = parseFile(
      'variables.tf',
      readFileSync(fixturePath('multimod', 'variables.tf'), 'utf8'),
    );
    expect(detectVersionHygiene(file, { variableDocs: false })).toEqual([]);
    const findings = detectVersionHygiene(file, { variableDocs: true });
    expect(findings.map((f) => f.code)).toEqual(['hygiene.variableDocs', 'hygiene.variableDocs']);
    expect(findings.map((f) => f.message).join(' ')).toContain('cidr');
    expect(findings.map((f) => f.message).join(' ')).toContain('lista');
  });
});

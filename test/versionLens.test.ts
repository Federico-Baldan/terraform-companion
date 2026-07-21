import { beforeAll, describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/parser';
import {
  computeVersionTargets,
  isRegistryModuleSource,
  isRegistryProviderSource,
  registryUrl,
  updateChoiceLabel,
  updatedConstraintText,
  type VersionTarget,
} from '../src/features/versionLens';
import { initTestParser } from './helpers';

const target = (over: Partial<VersionTarget>): VersionTarget => ({
  span: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  valueSpan: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  source: 'hashicorp/aws',
  isModule: false,
  constraint: '~> 5.34.0',
  ...over,
});

const SRC = `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.34.0"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "3.0.0"
}

module "local" {
  source = "./modules/net"
}

module "from_git" {
  source  = "git::https://example.com/x.git?ref=v1.2.0"
  version = "1.2.0"
}
`;

beforeAll(async () => {
  await initTestParser();
});

describe('F1 version targets', () => {
  it('finds provider requirements with a version and registry modules only', () => {
    const targets = computeVersionTargets(parseFile('main.tf', SRC));
    expect(targets).toHaveLength(2);

    const provider = targets.find((t) => !t.isModule)!;
    expect(provider.source).toBe('hashicorp/aws');
    expect(provider.constraint).toBe('~> 5.34.0');
    expect(provider.span.start.row).toBe(4);

    const mod = targets.find((t) => t.isModule)!;
    expect(mod.source).toBe('terraform-aws-modules/vpc/aws');
    expect(mod.constraint).toBe('3.0.0');
  });

  it('strips registry submodule suffixes', () => {
    const src = 'module "x" {\n  source  = "ns/name/aws//modules/sub"\n  version = "1.0.0"\n}\n';
    const targets = computeVersionTargets(parseFile('m.tf', src));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.source).toBe('ns/name/aws');
  });

  it('excludes github.com shorthand sources (hostname, not a registry namespace)', () => {
    const src =
      'module "x" {\n  source  = "github.com/hashicorp/example"\n  version = "1.0.0"\n}\n';
    expect(computeVersionTargets(parseFile('g.tf', src))).toEqual([]);
  });

  it('strips the explicit default registry host from provider sources', () => {
    const src = `terraform {
  required_providers {
    aws = {
      source  = "registry.terraform.io/hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
`;
    const targets = computeVersionTargets(parseFile('h.tf', src));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.source).toBe('hashicorp/aws');
    expect(registryUrl(targets[0]!)).toBe(
      'https://registry.terraform.io/providers/hashicorp/aws/latest',
    );
  });

  it('supports the legacy string form and the implied hashicorp/ source', () => {
    const src = `terraform {
  required_providers {
    aws = ">= 5.0"
    google = {
      version = "~> 6.0"
    }
  }
}
`;
    const targets = computeVersionTargets(parseFile('i.tf', src));
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => [t.source, t.constraint])).toEqual([
      ['hashicorp/aws', '>= 5.0'],
      ['hashicorp/google', '~> 6.0'],
    ]);
  });
});

describe('explicit registry.terraform.io host', () => {
  it('is accepted for modules, not just providers', () => {
    const src = `
terraform {
  required_providers {
    aws = { source = "registry.terraform.io/hashicorp/aws", version = "5.0" }
  }
}
module "vpc" {
  source  = "registry.terraform.io/terraform-aws-modules/vpc/aws"
  version = "5.0"
}
`;
    const targets = computeVersionTargets(parseFile('a.tf', src));
    // the host is stripped from both, so the API query and registry URL work
    expect(targets.map((t) => [t.source, t.isModule])).toEqual([
      ['hashicorp/aws', false],
      ['terraform-aws-modules/vpc/aws', true],
    ]);
  });

  it('still rejects private registries and git sources', () => {
    expect(isRegistryModuleSource('app.terraform.io/acme/vpc/aws')).toBe(false);
    expect(isRegistryModuleSource('github.com/acme/vpc')).toBe(false);
    expect(isRegistryModuleSource('./local/vpc')).toBe(false);
  });
});

describe('isRegistryProviderSource', () => {
  it('accepts ordinary namespace/name provider addresses', () => {
    expect(isRegistryProviderSource('hashicorp/aws')).toBe(true);
    // a real, hyphenated provider name
    expect(isRegistryProviderSource('hashicorp/google-beta')).toBe(true);
  });

  // namespace half was already guarded (no dot); name half had no charset
  // check at all, so "ns/<garbage>" built a registry request URL straight
  // from unvalidated .tf file content
  it('rejects a name segment carrying characters no registry slug has', () => {
    expect(isRegistryProviderSource('hashicorp/../secrets')).toBe(false);
    expect(isRegistryProviderSource('hashicorp/aws?x=1')).toBe(false);
    expect(isRegistryProviderSource('hashicorp/aws/extra')).toBe(false);
    expect(isRegistryProviderSource('hashicorp/')).toBe(false);
  });

  it('still rejects a namespace carrying a host-shaped dot', () => {
    expect(isRegistryProviderSource('app.terraform.io/acme')).toBe(false);
  });
});

describe('a ceiling survives whichever order it is written in', () => {
  it('keeps the upper bound when it comes first', () => {
    // the ceiling used to be silently deleted, and the label blamed the floor
    expect(updatedConstraintText(target({ constraint: '< 6.0, >= 5.0' }), '5.98.0')).toBe(
      '">= 5.98.0, < 6.0"',
    );
    expect(updateChoiceLabel(target({ constraint: '< 6.0, >= 5.0' }), '5.98.0')).toBe(
      'Update to ">= 5.98.0, < 6.0"',
    );
  });

  it('produces the same edit for both orderings', () => {
    expect(updatedConstraintText(target({ constraint: '< 6.0, >= 5.0' }), '5.98.0')).toBe(
      updatedConstraintText(target({ constraint: '>= 5.0, < 6.0' }), '5.98.0'),
    );
  });

  it('bumps the highest floor and reports the redundant one', () => {
    expect(updateChoiceLabel(target({ constraint: '>= 3.0, >= 5.0' }), '5.98.0')).toBe(
      'Update to ">= 5.98.0" (drops ">= 3.0")',
    );
  });
});

describe('updateChoiceLabel', () => {
  it('labels a single-clause update plainly', () => {
    expect(updateChoiceLabel(target({ constraint: '~> 5.34.0' }), '5.98.0')).toBe(
      'Update to "~> 5.98.0"',
    );
  });

  it('keeps an upper bound that still admits the new version, without a warning', () => {
    expect(updateChoiceLabel(target({ constraint: '>= 4.0, < 6.0' }), '5.98.0')).toBe(
      'Update to ">= 5.98.0, < 6.0"',
    );
  });

  it('spells out an upper bound the new version would violate', () => {
    // keeping "< 6.0" here would emit an unsatisfiable ">= 6.2.0, < 6.0"
    expect(updateChoiceLabel(target({ constraint: '>= 4.0, < 6.0' }), '6.2.0')).toBe(
      'Update to ">= 6.2.0" (drops "< 6.0")',
    );
  });

  it('spells out a non-ceiling clause that cannot survive the bump', () => {
    expect(updateChoiceLabel(target({ constraint: '>= 4.0, != 4.5' }), '5.98.0')).toBe(
      'Update to ">= 5.98.0" (drops "!= 4.5")',
    );
  });
});

describe('updatedConstraintText', () => {
  it('preserves the pessimistic operator for providers', () => {
    expect(updatedConstraintText(target({ constraint: '~> 5.34.0' }), '5.98.0')).toBe(
      '"~> 5.98.0"',
    );
  });

  it('preserves a comparison operator instead of forcing ~>', () => {
    expect(updatedConstraintText(target({ constraint: '>= 5.0' }), '5.98.0')).toBe('">= 5.98.0"');
  });

  it('normalises exact/bare constraints to a bare version', () => {
    expect(updatedConstraintText(target({ isModule: true, constraint: '3.0.0' }), '5.98.0')).toBe(
      '"5.98.0"',
    );
    expect(updatedConstraintText(target({ constraint: '= 5.34.0' }), '5.98.0')).toBe('"5.98.0"');
  });

  it('falls back to ~> for providers and exact for modules when no constraint', () => {
    expect(updatedConstraintText(target({ constraint: '' }), '5.98.0')).toBe('"~> 5.98.0"');
    expect(updatedConstraintText(target({ isModule: true, constraint: '' }), '5.98.0')).toBe(
      '"5.98.0"',
    );
  });

  it('preserves <= (still includes latest)', () => {
    expect(updatedConstraintText(target({ constraint: '<= 5.0' }), '5.98.0')).toBe('"<= 5.98.0"');
  });

  it('drops operators that would exclude the offered version', () => {
    expect(updatedConstraintText(target({ constraint: '< 6.0' }), '5.98.0')).toBe('"~> 5.98.0"');
    expect(updatedConstraintText(target({ constraint: '> 5.0' }), '5.98.0')).toBe('"~> 5.98.0"');
    expect(
      updatedConstraintText(target({ isModule: true, constraint: '!= 5.1.0' }), '5.98.0'),
    ).toBe('"5.98.0"');
  });

  /** With `~>` the number of segments written *is* the constraint: "~> 5.34"
   *  allows every 5.x from 5.34 up, "~> 5.98.0" allows only 5.98.x. Writing
   *  the full version back would silently demote a minor-range pin to
   *  patch-range — an upgrade the author never asked for. */
  it('keeps the precision of a pessimistic constraint', () => {
    expect(updatedConstraintText(target({ constraint: '~> 5.34' }), '5.98.0')).toBe('"~> 5.98"');
    expect(updatedConstraintText(target({ constraint: '~> 5.34' }), '6.2.0')).toBe('"~> 6.2"');
    // except a single segment, which caps nothing and so is widened to two —
    // see 'widens a single-segment ~>' below
    expect(updatedConstraintText(target({ constraint: '~> 5' }), '6.2.0')).toBe('"~> 6.2"');
    // three segments written, three segments back
    expect(updatedConstraintText(target({ constraint: '~> 5.34.0' }), '5.98.0')).toBe(
      '"~> 5.98.0"',
    );
  });

  it('keeps full precision for non-pessimistic operators', () => {
    expect(updatedConstraintText(target({ constraint: '>= 5.0' }), '5.98.0')).toBe('">= 5.98.0"');
  });
});

describe('registryUrl', () => {
  it('points providers and modules at their registry pages', () => {
    expect(registryUrl(target({ source: 'hashicorp/aws' }))).toBe(
      'https://registry.terraform.io/providers/hashicorp/aws/latest',
    );
    expect(registryUrl(target({ isModule: true, source: 'terraform-aws-modules/vpc/aws' }))).toBe(
      'https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/latest',
    );
  });
});

describe('provider sources are filtered like module sources', () => {
  it('skips providers served by a private registry host', () => {
    // every one of these used to be looked up on registry.terraform.io,
    // sending an internal provider name to a third party for a request that
    // can only 404
    const src = `terraform {
  required_providers {
    mycloud = {
      source  = "app.terraform.io/acme/mycloud"
      version = ">= 1.0"
    }
    internal = {
      source  = "registry.example.com/team/internal"
      version = "~> 2.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
`;
    const targets = computeVersionTargets(parseFile('a.tf', src));
    expect(targets.map((t) => t.source)).toEqual(['hashicorp/aws']);
  });

  it('keeps the default registry host written out in full', () => {
    const src = `terraform {
  required_providers {
    aws = {
      source  = "registry.terraform.io/hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
`;
    expect(computeVersionTargets(parseFile('b.tf', src)).map((t) => t.source)).toEqual([
      'hashicorp/aws',
    ]);
  });

  it('still handles the legacy string form and an implied hashicorp source', () => {
    const src = `terraform {
  required_providers {
    aws    = ">= 5.0"
    random = { version = "~> 3.0" }
  }
}
`;
    expect(computeVersionTargets(parseFile('c.tf', src)).map((t) => t.source)).toEqual([
      'hashicorp/aws',
      'hashicorp/random',
    ]);
  });
});

describe('a bump must actually change the constraint', () => {
  const target = (constraint: string) => ({
    span: { start: { row: 0, column: 0 }, end: { row: 0, column: 1 } },
    valueSpan: { start: { row: 0, column: 0 }, end: { row: 0, column: 1 } },
    source: 'hashicorp/aws',
    isModule: false,
    constraint,
  });

  it('widens a single-segment ~> instead of truncating back to itself', () => {
    // "~> 5" kept its precision straight back to "5": the QuickPick offered
    // `Update to "~> 5"` and applying it edited nothing
    expect(updatedConstraintText(target('~> 5'), '5.98.0')).toBe('"~> 5.98"');
  });

  it('widens a single-segment ~> across a major bump too', () => {
    // "~> 6" is as uncapped as the "~> 5" it replaces, so versionHygiene
    // flagged the very constraint this quick fix had just written
    expect(updatedConstraintText(target('~> 5'), '6.2.0')).toBe('"~> 6.2"');
  });

  it('still keeps the precision the author wrote when it moves', () => {
    expect(updatedConstraintText(target('~> 5.34'), '5.98.0')).toBe('"~> 5.98"');
    expect(updatedConstraintText(target('~> 5.34.0'), '5.98.0')).toBe('"~> 5.98.0"');
  });
});

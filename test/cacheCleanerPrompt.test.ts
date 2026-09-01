import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scan } from '../src/features/cacheCleanerProvider';
import { mock, type QuickPickItem, resetVscodeMock } from './mocks/vscode';

const DAY = 86_400_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tfc-prompt-'));
  resetVscodeMock();
  mock.folders = [{ uri: { fsPath: root } }];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(p, t, t);
}

/** A module with a real, backdated .terraform cache. `rel` may be nested, which
 *  is the point: the prompt has to name `infra/prod`, not `.terraform`. */
function module_(
  rel: string,
  days: number,
  opts: { modules?: boolean; handPlaced?: boolean } = {},
) {
  const dir = join(root, rel);
  const cache = join(dir, '.terraform');
  const providers = join(cache, 'providers');
  mkdirSync(providers, { recursive: true });
  writeFileSync(join(providers, 'terraform-provider-aws'), 'x'.repeat(4096));
  writeFileSync(join(dir, 'main.tf'), 'resource "null_resource" "x" {}');
  // metadata terraform init cannot reconstruct: must survive every path below
  writeFileSync(join(cache, 'environment'), 'prod');
  const touched = [
    join(providers, 'terraform-provider-aws'),
    providers,
    join(dir, 'main.tf'),
    join(cache, 'environment'),
  ];
  if (opts.modules) {
    mkdirSync(join(cache, 'modules'), { recursive: true });
    writeFileSync(join(cache, 'modules', 'modules.json'), '{}');
    touched.push(join(cache, 'modules', 'modules.json'), join(cache, 'modules'));
  }
  if (opts.handPlaced) {
    const platform = join(cache, 'plugins', 'darwin_arm64');
    mkdirSync(platform, { recursive: true });
    // no lock.json: terraform init cannot refetch this, so it is never a victim
    writeFileSync(join(platform, 'terraform-provider-inhouse'), 'ELF');
    touched.push(join(platform, 'terraform-provider-inhouse'), platform, join(cache, 'plugins'));
  }
  touched.push(cache, dir);
  for (const p of touched) age(p, days);
  return cache;
}

function memento(): never {
  const store = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
    update: async (k: string, v: unknown) => void store.set(k, v),
    keys: () => [...store.keys()],
  } as never;
}

const silent = () => {};

async function run(): Promise<void> {
  await scan(silent, () => false, memento());
}

function prompt(): string {
  expect(mock.warnings).toHaveLength(1);
  return mock.warnings[0]!.message;
}

function picker(): QuickPickItem[] {
  expect(mock.quickPicks).toHaveLength(1);
  return mock.quickPicks[0]!.items;
}

/** The whole point of the change: "3 .terraform folders, delete?" gave the user
 *  nothing to check the answer against, so the only available reply was a blind
 *  yes on a recursive delete. */
describe('cache cleaner prompt', () => {
  it('names the folder it wants to delete', async () => {
    module_('infra/prod', 90);
    mock.warningAnswers = ['Ignore'];
    await run();
    expect(prompt()).toContain('infra/prod');
    // and it is still an offer, not a report of something already done
    expect(existsSync(join(root, 'infra/prod/.terraform/providers'))).toBe(true);
  });

  it('names every folder while they fit, then counts the rest', async () => {
    for (const name of ['a', 'b', 'c']) module_(`infra/${name}`, 90);
    mock.warningAnswers = ['Ignore'];
    await run();
    for (const name of ['a', 'b', 'c']) expect(prompt()).toContain(`infra/${name}`);
    expect(prompt()).not.toContain('more');

    resetVscodeMock();
    mock.folders = [{ uri: { fsPath: root } }];
    module_('infra/d', 90);
    module_('infra/e', 90);
    mock.warningAnswers = ['Ignore'];
    await run();
    expect(prompt()).toContain('and 2 more');
  });

  it('offers a review that shows the path, the size and the exact subdirectories', async () => {
    module_('infra/prod', 90, { modules: true, handPlaced: true });
    mock.warningAnswers = ['Review…'];
    mock.pick = () => undefined; // escaped
    await run();

    const [item] = picker();
    expect(item?.label).toBe('infra/prod');
    expect(item?.picked).toBe(true);
    expect(item?.description).toMatch(/KB · last activity \d{4}-\d{2}-\d{2}$/);
    expect(item?.detail).toContain(join(root, 'infra/prod', '.terraform'));
    expect(item?.detail).toContain('deletes .terraform/providers, .terraform/modules');
    // the hand-placed plugin is never offered, because the delete would decline it
    expect(item?.detail).not.toContain('darwin_arm64');
  });

  it('deletes only what was left checked', async () => {
    module_('infra/prod', 90);
    module_('modules/vpc', 90);
    mock.warningAnswers = ['Review…'];
    mock.pick = (items) => items.filter((i) => i.label === 'modules/vpc');
    await run();

    expect(existsSync(join(root, 'infra/prod/.terraform/providers'))).toBe(true);
    expect(existsSync(join(root, 'modules/vpc/.terraform/providers'))).toBe(false);
    // and the result names what actually went, not what was found
    expect(mock.infos[0]).toContain('modules/vpc');
    expect(mock.infos[0]).not.toContain('infra/prod');
  });

  it('deletes nothing when the review is escaped or emptied', async () => {
    module_('infra/prod', 90);
    for (const pick of [() => undefined, () => []] as (() => QuickPickItem[] | undefined)[]) {
      mock.warningAnswers = ['Review…'];
      mock.pick = pick;
      await run();
      expect(existsSync(join(root, 'infra/prod/.terraform/providers'))).toBe(true);
      expect(mock.infos).toEqual([]);
      mock.warnings = [];
      mock.quickPicks = [];
    }
  });

  it('skips the picker on Delete all and keeps the metadata', async () => {
    module_('infra/prod', 90, { modules: true, handPlaced: true });
    module_('modules/vpc', 90);
    mock.warningAnswers = ['Delete all 2'];
    await run();

    expect(mock.quickPicks).toEqual([]);
    expect(existsSync(join(root, 'infra/prod/.terraform/providers'))).toBe(false);
    expect(existsSync(join(root, 'modules/vpc/.terraform/providers'))).toBe(false);
    // .terraform itself, the selected workspace and the hand-placed binary stay
    expect(existsSync(join(root, 'infra/prod/.terraform/environment'))).toBe(true);
    expect(
      existsSync(
        join(root, 'infra/prod/.terraform/plugins/darwin_arm64/terraform-provider-inhouse'),
      ),
    ).toBe(true);
  });

  it('leaves everything alone on Ignore', async () => {
    module_('infra/prod', 90);
    mock.warningAnswers = ['Ignore'];
    await run();
    expect(existsSync(join(root, 'infra/prod/.terraform/providers'))).toBe(true);
    expect(mock.infos).toEqual([]);
  });

  it('never prompts about a module that is still in use', async () => {
    module_('infra/dev', 1);
    await run();
    expect(mock.warnings).toEqual([]);
    expect(existsSync(join(root, 'infra/dev/.terraform/providers'))).toBe(true);
  });

  /** autoDelete skips the prompt, so the output channel is the only record of
   *  what went — it has to name the folders and the subdirectories. */
  it('logs every folder and subdirectory when autoDelete skips the prompt', async () => {
    module_('infra/prod', 90, { modules: true });
    mock.settings.set('cacheCleaner.autoDelete', true);
    const logged: string[] = [];
    await scan(
      (m) => logged.push(m),
      () => false,
      memento(),
    );

    expect(mock.warnings).toEqual([]);
    expect(logged.some((l) => l.includes('infra/prod') && l.includes('will delete'))).toBe(true);
    expect(logged.some((l) => l.includes('removed providers, modules'))).toBe(true);
    expect(existsSync(join(root, 'infra/prod/.terraform/providers'))).toBe(false);
  });

  it('does not scan at all when the feature is off', async () => {
    module_('infra/prod', 90);
    mock.settings.set('cacheCleaner.enabled', false);
    await run();
    expect(mock.warnings).toEqual([]);
    expect(existsSync(join(root, 'infra/prod/.terraform/providers'))).toBe(true);
  });
});

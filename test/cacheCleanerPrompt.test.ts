import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scan } from '../src/features/cacheCleanerProvider';
import { mock, type QuickPickItem, resetVscodeMock } from './mocks/vscode';

const DAY = 86_400_000;

let root: string;
let cacheHome: string;
const ENV_KEYS = ['TF_CLI_CONFIG_FILE', 'TF_PLUGIN_CACHE_DIR'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tfc-prompt-'));
  cacheHome = mkdtempSync(join(tmpdir(), 'tfc-plugins-'));
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  resetVscodeMock();
  mock.folders = [{ uri: { fsPath: root } }];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(cacheHome, { recursive: true, force: true });
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
/** The shared plugin cache is not the workspace's: every Terraform project on the
 *  machine links into it, and Terraform never writes to an entry after
 *  installing it. So nothing here is deleted unless the user switched the
 *  feature on, and nothing is deleted without being asked — not even under
 *  `autoDelete`, which was only ever meant for a workspace's own `.terraform`. */
describe('shared provider cache', () => {
  const UNUSED = 'registry.terraform.io/example/unused';
  const AWS = 'registry.terraform.io/hashicorp/aws';

  /** A provider version as `terraform init` leaves it: a binary under an
   *  os_arch directory, all of it installed `days` ago. */
  function provider(source: string, days = 90): { version: string; binary: string } {
    const version = join(cacheHome, ...source.split('/'), '1.0.0');
    const platformDir = join(version, 'linux_amd64');
    mkdirSync(platformDir, { recursive: true });
    const binary = join(platformDir, 'terraform-provider');
    writeFileSync(binary, 'x'.repeat(4096));
    for (const p of [binary, platformDir, version]) age(p, days);
    return { version, binary };
  }

  function lockFile(rel: string, source: string): string {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '.terraform.lock.hcl');
    writeFileSync(file, `provider "${source}" {\n  version = "1.0.0"\n}\n`);
    return file;
  }

  function enable(): void {
    process.env.TF_PLUGIN_CACHE_DIR = cacheHome;
    mock.settings.set('cacheCleaner.providerCache', true);
  }

  async function runLogged(): Promise<string[]> {
    const logged: string[] = [];
    await scan(
      (m) => logged.push(m),
      () => false,
      memento(),
    );
    return logged;
  }

  it('is on by default, and asks before it removes anything', async () => {
    const { version } = provider(UNUSED);
    process.env.TF_PLUGIN_CACHE_DIR = cacheHome;
    mock.warningAnswers = ['Ignore'];
    await run();

    expect(mock.warnings).toHaveLength(1);
    expect(prompt()).toContain(cacheHome);
    expect(existsSync(version)).toBe(true);
  });

  it('leaves the shared cache alone when it is switched off', async () => {
    const { version } = provider(UNUSED);
    process.env.TF_PLUGIN_CACHE_DIR = cacheHome;
    mock.settings.set('cacheCleaner.providerCache', false);
    await run();
    expect(mock.warnings).toEqual([]);
    expect(existsSync(version)).toBe(true);
  });

  it('says what stale means here, and that other projects may still use the entry', async () => {
    provider(UNUSED);
    enable();
    mock.warningAnswers = ['Ignore'];
    await run();

    const message = prompt();
    // the only date available is the install date, so the prompt must not call it "unused"
    expect(message).toContain('installed over 30 days ago');
    expect(message).not.toContain('unused');
    expect(message).toContain('Other projects');
    expect(message).toContain(cacheHome);
  });

  it('deletes an unreferenced provider on Delete and keeps one a lock file names', async () => {
    const gone = provider(UNUSED);
    const kept = provider(AWS);
    lockFile('infra/prod', AWS);
    enable();
    mock.warningAnswers = ['Delete'];
    await run();

    expect(existsSync(gone.version)).toBe(false);
    expect(existsSync(kept.version)).toBe(true);
    expect(mock.infos[0]).toContain('freed');
  });

  it('still asks when autoDelete is on', async () => {
    const { version } = provider(UNUSED);
    enable();
    mock.settings.set('cacheCleaner.autoDelete', true);
    mock.warningAnswers = ['Ignore'];
    await run();

    expect(mock.warnings).toHaveLength(1);
    expect(existsSync(version)).toBe(true);
  });

  it('does nothing when no workspace folder is open, since nothing then protects anything', async () => {
    const { version } = provider(UNUSED);
    enable();
    mock.folders = [];
    const logged = await runLogged();

    expect(mock.warnings).toEqual([]);
    expect(existsSync(version)).toBe(true);
    expect(logged.some((l) => l.includes('provider cache') && l.includes('workspace'))).toBe(true);
  });

  it('does nothing when a lock file in the workspace cannot be read', async () => {
    const { version } = provider(UNUSED);
    enable();
    mkdirSync(join(root, 'mod'));
    // dangling: unreadable whoever runs the test, root included
    symlinkSync(join(cacheHome, 'missing.hcl'), join(root, 'mod', '.terraform.lock.hcl'));
    await run();

    expect(mock.warnings).toEqual([]);
    expect(existsSync(version)).toBe(true);
  });

  it('is protected by a lock file that is a symlink to a shared one', async () => {
    const { version } = provider(UNUSED);
    enable();
    // the real file lives outside the workspace, so only following the link can
    // bring its provider into the protected set
    const shared = join(cacheHome, 'shared.lock.hcl');
    writeFileSync(shared, `provider "${UNUSED}" {\n  version = "1.0.0"\n}\n`);
    mkdirSync(join(root, 'mod'));
    symlinkSync(shared, join(root, 'mod', '.terraform.lock.hcl'));
    await run();

    expect(mock.warnings).toEqual([]);
    expect(existsSync(version)).toBe(true);
  });

  it('stays quiet for a week once the prompt is ignored', async () => {
    provider(UNUSED);
    enable();
    mock.warningAnswers = ['Ignore'];
    const state = memento();
    await scan(silent, () => false, state);
    await scan(silent, () => false, state);
    expect(mock.warnings).toHaveLength(1);
  });

  it('does not delete a provider that was written while the prompt was open', async () => {
    const { version, binary } = provider(UNUSED);
    enable();
    mock.warningAnswers = ['Review…'];
    mock.pick = (items) => {
      age(binary, 0); // a terraform init in another project, mid-prompt
      return items;
    };
    await run();

    expect(existsSync(version)).toBe(true);
    expect(mock.infos).toEqual([]);
  });

  /** Reuse leaves no trace in the cache, so the only way to learn that a
   *  provider became needed while the prompt was open is to read the lock files
   *  again just before deleting. */
  it('reads the lock files again before deleting, so a provider named meanwhile survives', async () => {
    const { version } = provider(UNUSED);
    enable();
    mock.warningAnswers = ['Review…'];
    mock.pick = (items) => {
      lockFile('proj', UNUSED); // a terraform init in this workspace, mid-prompt
      return items;
    };
    await run();

    expect(existsSync(version)).toBe(true);
    expect(mock.infos).toEqual([]);
  });

  it('deletes nothing if the lock files cannot be read again', async () => {
    const { version } = provider(UNUSED);
    enable();
    mock.warningAnswers = ['Review…'];
    mock.pick = (items) => {
      mkdirSync(join(root, 'mod'));
      symlinkSync(join(cacheHome, 'missing.hcl'), join(root, 'mod', '.terraform.lock.hcl'));
      return items;
    };
    await run();

    expect(existsSync(version)).toBe(true);
  });

  it('protects a project whose .terraform/providers links into the cache, with or without a lock file', async () => {
    const { version } = provider(UNUSED);
    enable();
    const linked = join(root, 'proj', '.terraform', 'providers', ...UNUSED.split('/'), '1.0.0');
    mkdirSync(join(linked, '..'), { recursive: true });
    symlinkSync(version, linked);
    await run();

    expect(mock.warnings).toEqual([]);
    expect(existsSync(version)).toBe(true);
  });

  it('stays quiet for a week after Esc or an emptied review', async () => {
    provider(UNUSED);
    for (const pick of [() => undefined, () => []] as (() => QuickPickItem[] | undefined)[]) {
      resetVscodeMock();
      mock.folders = [{ uri: { fsPath: root } }];
      enable();
      mock.warningAnswers = ['Review…'];
      mock.pick = pick;
      const state = memento();
      await scan(silent, () => false, state);
      await scan(silent, () => false, state);
      expect(mock.warnings).toHaveLength(1);
    }
  });

  it('stays quiet for a week after keeping some of what was offered', async () => {
    provider(UNUSED);
    provider('registry.terraform.io/example/other');
    enable();
    mock.warningAnswers = ['Review…'];
    mock.pick = (items) => items.filter((i) => i.label.includes('unused'));
    const state = memento();
    await scan(silent, () => false, state);
    await scan(silent, () => false, state);
    expect(mock.warnings).toHaveLength(1);
  });

  it('says so when an entry could not be removed', async () => {
    const { version } = provider(UNUSED);
    enable();
    mock.warningAnswers = ['Review…'];
    mock.pick = (items) => {
      // swapped for a file of the same age: not a directory any more when it is deleted
      rmSync(version, { recursive: true });
      writeFileSync(version, 'x');
      age(version, 90);
      return items;
    };
    await run();

    expect(mock.warnings).toHaveLength(2);
    expect(mock.warnings[1]!.message).toContain('could not be removed');
  });

  /** A walk cut short by a closing window found "nothing" only because it did not
   *  finish, and recording that as a 24-hour quiet period hides real entries. */
  it('records no quiet period when the window closes during the walk', async () => {
    provider(AWS);
    lockFile('proj', AWS); // protected, so a finished walk finds nothing and snoozes
    enable();
    let sawCancel = false;
    for (let limit = 0; limit < 80; limit++) {
      const state = memento();
      let calls = 0;
      await scan(silent, () => ++calls > limit, state);
      if (calls > limit) {
        sawCancel = true;
        expect((state as unknown as { keys(): string[] }).keys()).toEqual([]);
      }
    }
    expect(sawCancel).toBe(true);
  });

  it('names the picker entries by install, with the date they were last written', async () => {
    provider(UNUSED);
    enable();
    mock.warningAnswers = ['Review…'];
    mock.pick = () => undefined;
    await run();

    const { items, options } = mock.quickPicks[0]!;
    expect(String(options.title)).toContain('installed');
    expect(String(options.title)).not.toContain('Unused');
    expect(items[0]?.description).toMatch(/last written \d{4}-\d{2}-\d{2}$/);
  });

  it('stops deleting once the window is closing', async () => {
    const { version } = provider(UNUSED);
    enable();
    let closing = false;
    mock.warningAnswers = ['Review…'];
    mock.pick = (items) => {
      closing = true;
      return items;
    };
    await scan(silent, () => closing, memento());

    expect(existsSync(version)).toBe(true);
  });
});

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
    expect(mock.infos).toEqual([]);
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

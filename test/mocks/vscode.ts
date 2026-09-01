/** Minimal stand-in for the `vscode` module, aliased in by vitest.config.ts.
 *
 *  The extension host is not available under vitest, so anything importing
 *  `vscode` was untestable — which left the cache cleaner's prompt, the one
 *  piece of UI in this extension that can delete a user's files, covered by
 *  nothing at all. This mock records what was shown and replays a scripted
 *  answer, so a test can assert on the exact notification text and drive the
 *  review picker.
 *
 *  Only the surface the extension actually calls is implemented. */

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
}

interface ShownWarning {
  message: string;
  items: string[];
}

interface ShownQuickPick {
  items: QuickPickItem[];
  options: Record<string, unknown>;
}

export const mock = {
  /** tfCompanion.* overrides, keyed without the section prefix */
  settings: new Map<string, unknown>(),
  folders: [] as { uri: { fsPath: string } }[],
  warnings: [] as ShownWarning[],
  infos: [] as string[],
  quickPicks: [] as ShownQuickPick[],
  /** consumed in order, one per showWarningMessage call */
  warningAnswers: [] as (string | undefined)[],
  /** given the items as shown, return what the user checked (undefined = Esc) */
  pick: (items: QuickPickItem[]): QuickPickItem[] | undefined => items,
};

export function resetVscodeMock(): void {
  mock.settings = new Map();
  mock.folders = [];
  mock.warnings = [];
  mock.infos = [];
  mock.quickPicks = [];
  mock.warningAnswers = [];
  mock.pick = (items) => items;
}

export const window = {
  showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
    mock.warnings.push({ message, items });
    return Promise.resolve(mock.warningAnswers.shift());
  },
  showInformationMessage(message: string): Promise<string | undefined> {
    mock.infos.push(message);
    return Promise.resolve(undefined);
  },
  showQuickPick<T extends QuickPickItem>(
    items: T[],
    options: Record<string, unknown>,
  ): Promise<T[] | undefined> {
    mock.quickPicks.push({ items, options });
    return Promise.resolve(mock.pick(items) as T[] | undefined);
  },
};

export const workspace = {
  get workspaceFolders(): { uri: { fsPath: string } }[] {
    return mock.folders;
  },
  getConfiguration(_section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        return (mock.settings.has(key) ? mock.settings.get(key) : fallback) as T;
      },
    };
  },
};

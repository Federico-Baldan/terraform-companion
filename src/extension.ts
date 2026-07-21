import { join } from 'node:path';
import * as vscode from 'vscode';
import { versionLensCacheTtlHours } from './config';
import { initParser } from './core/parser';
import { WorkspaceIndex } from './core/workspaceIndex';
import { registerCacheCleaner } from './features/cacheCleanerProvider';
import { registerCountForEach } from './features/countForEachProvider';
import { registerResolvedHover } from './features/resolvedHoverProvider';
import { registerVersionLens } from './features/versionLensProvider';
import { registerIndexSync } from './indexSync';
import { registerLintPipeline } from './lintPipeline';
import { buildLintRules } from './lintRules';
import { type CacheEntry, pruneRegistryCache, RegistryClient } from './registry/client';
import { vscodeHost } from './vscodeUtils';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Terraform Companion');
  context.subscriptions.push(output);
  const log = (m: string) => output.appendLine(m);

  try {
    await initParser({
      runtimeWasm: join(context.extensionPath, 'dist', 'web-tree-sitter.wasm'),
      grammarWasm: join(context.extensionPath, 'dist', 'tree-sitter-terraform.wasm'),
    });
  } catch (e) {
    log(`Parser init failed: ${e}`);
    return;
  }

  const index = await WorkspaceIndex.build(vscodeHost(), (path, e) =>
    log(`Not indexed (unreadable or deleted during the scan): ${path}: ${e}`),
  );

  const pipeline = registerLintPipeline(context, buildLintRules(), index, log);

  const pruned = pruneRegistryCache(
    context.globalState.keys(),
    (k) => context.globalState.get<CacheEntry>(k),
    // a rejected removal discarded with `void` surfaces as an unhandled
    // rejection in the extension host; a surviving key is retried next time
    (k) =>
      void Promise.resolve(context.globalState.update(k, undefined)).catch((e) =>
        log(`Registry cache prune failed for ${k}: ${e}`),
      ),
  );
  if (pruned > 0) log(`Dropped ${pruned} stale registry cache entr${pruned === 1 ? 'y' : 'ies'}`);

  const registry = new RegistryClient(
    {
      get: (k) => context.globalState.get<CacheEntry>(`registry:${k}`),
      // a rejected write discarded with `void` becomes an unhandled rejection
      set: (k, v) =>
        void Promise.resolve(context.globalState.update(`registry:${k}`, v)).catch((e) =>
          log(`Registry cache write failed for ${k}: ${e}`),
        ),
    },
    fetch,
    () => versionLensCacheTtlHours() * 3600_000,
  );
  const versionLens = registerVersionLens(context, registry);
  // before registerCountForEach: its quick fix resolves list values through the
  // active tfvars, so it needs the selection to exist first
  const activeTfvars = registerResolvedHover(context, index);
  registerCountForEach(context, index, activeTfvars);
  registerCacheCleaner(context, log);

  registerIndexSync(context, index, (changed) => {
    pipeline.refreshPaths(changed);
    versionLens.refresh();
    activeTfvars.updateStatusBar();
  });

  // settings changes must take effect without an edit: disabling a rule has to
  // clear its diagnostics right away, not leave them until the next keystroke
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tfCompanion')) {
        pipeline.refreshAll();
        versionLens.refresh();
      }
    }),
  );

  log(`Terraform Companion active: ${index.files().length} files indexed`);
}

export function deactivate(): void {}

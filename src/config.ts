import * as vscode from 'vscode';

/**
 * Single source of truth for reading tfCompanion.* settings.
 * Keys and defaults must stay in sync with the `contributes.configuration`
 * section of package.json.
 */
function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('tfCompanion');
}

/** Every feature exposes a tfCompanion.<feature>.enabled flag. */
export function featureEnabled(feature: string): boolean {
  return cfg().get<boolean>(`${feature}.enabled`, true);
}

/** Never below five minutes. Lenses recompute on every buffer change, so a TTL
 *  of 0 turns each keystroke burst into one request per provider in the file. */
const MIN_CACHE_TTL_HOURS = 5 / 60;
const DEFAULT_CACHE_TTL_HOURS = 6;

export function versionLensCacheTtlHours(): number {
  const configured = cfg().get<number>('versionLens.cacheTtlHours', DEFAULT_CACHE_TTL_HOURS);
  // Falls back to the default, not the floor: VS Code does not type-check
  // settings.json, and a garbled value must not select the most aggressive
  // behaviour available — here, the maximum registry traffic.
  return Number.isFinite(configured)
    ? Math.max(configured, MIN_CACHE_TTL_HOURS)
    : DEFAULT_CACHE_TTL_HOURS;
}

export function versionHygieneVariableDocs(): boolean {
  return cfg().get<boolean>('versionHygiene.variableDocs', false);
}

export function cacheCleanerStaleDays(): number {
  return cfg().get<number>('cacheCleaner.staleDays', 30);
}

export function cacheCleanerAutoDelete(): boolean {
  return cfg().get<boolean>('cacheCleaner.autoDelete', false);
}

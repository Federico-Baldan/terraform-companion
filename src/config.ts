import * as vscode from 'vscode';

/**
 * Single source of truth for reading tfCompanion.* settings.
 * Keys and defaults must stay in sync with the `contributes.configuration`
 * section of package.json.
 */
function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('tfCompanion');
}

/** settings.json is not type-checked, so a value can be anything the user
 *  typed. `"false"` is a string, and a truthy one — read as a boolean it turns
 *  a feature on that was meant to be off, and for `cacheCleaner.autoDelete`
 *  that means deleting without asking. Same reasoning as the numeric readers
 *  below: a garbled value falls back to the declared default, never to the more
 *  aggressive behaviour. */
function bool(key: string, fallback: boolean): boolean {
  const value = cfg().get<unknown>(key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

/** Every feature exposes a tfCompanion.<feature>.enabled flag. */
export function featureEnabled(feature: string): boolean {
  return bool(`${feature}.enabled`, true);
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
  return bool('versionHygiene.variableDocs', false);
}

const DEFAULT_STALE_DAYS = 30;
/** package.json declares a minimum of 1: below that every cache in the
 *  workspace reads as stale, which is the most destructive answer available. */
const MIN_STALE_DAYS = 1;

export function cacheCleanerStaleDays(): number {
  const configured = cfg().get<number>('cacheCleaner.staleDays', DEFAULT_STALE_DAYS);
  return Number.isFinite(configured) ? Math.max(configured, MIN_STALE_DAYS) : DEFAULT_STALE_DAYS;
}

export function cacheCleanerAutoDelete(): boolean {
  return bool('cacheCleaner.autoDelete', false);
}

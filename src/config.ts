import { isAbsolute } from 'node:path';
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

/** A directory setting, only if it can be used as written. VS Code does not
 *  expand `${workspaceFolder}` in a setting and settings.json is not
 *  type-checked, and a relative path would resolve against the extension host's
 *  own working directory, which is nobody's Terraform directory. */
function absolutePath(key: string): string | undefined {
  const value = cfg().get<unknown>(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.includes('${') || !isAbsolute(trimmed)) return undefined;
  // no directory Terraform reports carries a trailing separator, and one would
  // keep the setting from matching the directory the index spells without it.
  // A root (`/`, `C:\`) is all separator and stays as it is.
  const bare = trimmed.replace(/[\\/]+$/, '');
  if (bare === '') return trimmed.charAt(0);
  return /^[a-zA-Z]:$/.test(bare) ? trimmed.slice(0, bare.length + 1) : bare;
}

/** The Terraform root module directory, when the user said which it is. */
export function terraformRoot(): string | undefined {
  return absolutePath('terraformRoot');
}

/** The directory Terraform is run from, when the user said which it is. */
export function terraformCwd(): string | undefined {
  return absolutePath('terraformCwd');
}

export function cacheCleanerAutoDelete(): boolean {
  return bool('cacheCleaner.autoDelete', false);
}

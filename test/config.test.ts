import { beforeEach, describe, expect, it } from 'vitest';
import { terraformCwd, terraformRoot } from '../src/config';
import { mock, resetVscodeMock } from './mocks/vscode';

/** VS Code does not expand `${workspaceFolder}` in a setting, and settings.json is
 *  not type-checked: a value is whatever was typed. A relative path would be
 *  resolved against the extension host's working directory, which is nobody's
 *  Terraform directory. */
describe('terraformRoot and terraformCwd', () => {
  beforeEach(resetVscodeMock);

  it('drop a trailing separator, which no directory Terraform reports carries', () => {
    mock.settings.set('terraformRoot', '/work/infra/');
    mock.settings.set('terraformCwd', '/work//');
    expect(terraformRoot()).toBe('/work/infra');
    expect(terraformCwd()).toBe('/work');
    mock.settings.set('terraformRoot', '/');
    expect(terraformRoot()).toBe('/');
  });

  it('return an absolute path as given', () => {
    mock.settings.set('terraformRoot', '/work/infra');
    mock.settings.set('terraformCwd', '/work');
    expect(terraformRoot()).toBe('/work/infra');
    expect(terraformCwd()).toBe('/work');
  });

  it('ignore a relative path, an unexpanded variable, an empty or a non-string value', () => {
    for (const value of ['infra', '${workspaceFolder}/infra', '', '   ', 42, null]) {
      mock.settings.set('terraformRoot', value);
      mock.settings.set('terraformCwd', value);
      expect(terraformRoot()).toBeUndefined();
      expect(terraformCwd()).toBeUndefined();
    }
  });

  it('are unset by default', () => {
    expect(terraformRoot()).toBeUndefined();
    expect(terraformCwd()).toBeUndefined();
  });
});

import { versionHygieneVariableDocs } from './config';
import type { LintFinding } from './core/model';
import type { WorkspaceIndex } from './core/workspaceIndex';
import { countFinding, detectCountLength } from './features/countForEach';
import { detectRedundantDependsOn } from './features/dependsOn';
import { detectUnusedLocals } from './features/unusedLocals';
import { detectVersionHygiene } from './features/versionHygiene';
import type { LintRule } from './lintPipeline';

/** All diagnostic rules wired into the lint pipeline, one entry per feature. */
export function buildLintRules(): LintRule[] {
  // Unused locals are a property of the directory, but the pipeline asks per
  // file: a 12-file module would compute the same answer 12 times per refresh.
  let unusedCache = { gen: -1, byDir: new Map<string, LintFinding[]>() };
  const unusedLocalsOf = (idx: WorkspaceIndex, dir: string): LintFinding[] => {
    if (unusedCache.gen !== idx.generation()) {
      unusedCache = { gen: idx.generation(), byDir: new Map() };
    }
    let findings = unusedCache.byDir.get(dir);
    if (!findings) {
      findings = detectUnusedLocals(idx, dir);
      unusedCache.byDir.set(dir, findings);
    }
    return findings;
  };

  return [
    {
      feature: 'unusedLocals',
      // a local defined in one file is used from another in the same directory
      scope: 'module',
      appliesTo: (p) => p.endsWith('.tf'),
      run: (file, idx) =>
        unusedLocalsOf(idx, idx.moduleDirOf(file.path)).filter((f) => f.file === file.path),
    },
    {
      feature: 'versionHygiene',
      scope: 'file',
      appliesTo: (p) => p.endsWith('.tf'),
      run: (file) => detectVersionHygiene(file, { variableDocs: versionHygieneVariableDocs() }),
    },
    {
      feature: 'countForEach',
      scope: 'file',
      appliesTo: (p) => p.endsWith('.tf'),
      run: (file, idx) => detectCountLength(file, idx).map(countFinding),
    },
    {
      feature: 'dependsOn',
      scope: 'file',
      appliesTo: (p) => p.endsWith('.tf'),
      run: (file) => detectRedundantDependsOn(file),
    },
  ];
}

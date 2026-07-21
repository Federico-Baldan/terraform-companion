import type { LintFinding, ParsedFile } from './core/model';
import { normalizePath, type WorkspaceIndex } from './core/workspaceIndex';

export interface LintRule {
  /** settings key: tfCompanion.<feature>.enabled */
  feature: string;
  /** How far an edit reaches, which is what `planRelint` re-lints. 'module'
   *  means the findings also depend on sibling .tf files — unused locals is the
   *  one. There is deliberately no 'workspace' member: adding one has to be a
   *  decision about the incremental path, not an accident. */
  scope: 'file' | 'module';
  appliesTo: (path: string) => boolean;
  run: (file: ParsedFile, index: WorkspaceIndex) => LintFinding[];
}

export interface RelintPlan {
  /** indexed files whose diagnostics have to be recomputed */
  publish: ParsedFile[];
  /** paths that are no longer indexed, whose diagnostics have to be dropped */
  drop: string[];
}

/** Which files an edit to `changed` can have altered the findings of.
 *
 *  Kept apart from the pipeline, and vscode-free so it can be tested directly:
 *  this is the whole correctness question behind the incremental refresh. Too
 *  wide only costs time; too narrow leaves a wrong diagnostic on screen.
 *
 *  A changed path no longer in the index was deleted, and is reported for
 *  dropping — its directory is still re-linted. */
export function planRelint(
  index: WorkspaceIndex,
  changed: readonly string[],
  moduleScoped: boolean,
): RelintPlan {
  const paths = new Set(changed.map(normalizePath));
  const drop = [...paths].filter((p) => !index.file(p));
  const dirs = moduleScoped ? new Set([...paths].map((p) => index.moduleDirOf(p))) : undefined;
  const publish = index
    .files()
    .filter((f) => (dirs ? dirs.has(index.moduleDirOf(f.path)) : paths.has(f.path)));
  return { publish, drop };
}

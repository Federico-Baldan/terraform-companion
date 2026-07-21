import { spanContains } from '../core/hcl';
import type { LintFinding } from '../core/model';
import type { WorkspaceIndex } from '../core/workspaceIndex';

/** Locals never referenced as local.<name> in any .tf file of their module. */
export function detectUnusedLocals(index: WorkspaceIndex, moduleDir: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const def of index.localsOf(moduleDir)) {
    const uses = index.refsTo(['local', def.name]).filter(
      (u) =>
        index.moduleDirOf(u.file) === moduleDir &&
        // a reference inside its own definition does not make it "used"
        !(u.file === def.file && spanContains(def.attr.span, u.ref.span.start)),
    );
    if (uses.length === 0) {
      findings.push({
        code: 'locals.unused',
        message: `local.${def.name} is never used in this module.`,
        // the name only: the attr span would underline a whole multi-line value
        span: {
          start: def.attr.span.start,
          end: {
            row: def.attr.span.start.row,
            column: def.attr.span.start.column + def.name.length,
          },
        },
        file: def.file,
      });
    }
  }
  return findings;
}

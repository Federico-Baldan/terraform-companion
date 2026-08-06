export type Pos = { row: number; column: number };
export type Span = { start: Pos; end: Pos };

export interface TfAttr {
  name: string;
  span: Span;
  valueSpan: Span;
  valueText: string;
}

export interface TfBlock {
  kind: string;
  labels: string[];
  span: Span;
  bodySpan: Span;
  attrs: TfAttr[];
  blocks: TfBlock[];
}

export interface TfRef {
  parts: string[];
  span: Span;
}

export interface ParsedFile {
  path: string;
  /** the exact text this was parsed from, kept so the index can tell a real
   *  edit from a re-read of identical bytes */
  source: string;
  blocks: TfBlock[];
  refs: TfRef[];
  /** tree-sitter had to error-recover, so `refs` is a floor rather than the
   *  whole truth — a half-typed file parses to *fewer* references than it
   *  really has. Anything treating an absent reference as permission (the
   *  count→for_each rewrite, the unused-local lint) must consult this first. */
  hasError: boolean;
  /** materialised on first read, then cached — see `parseFile` */
  lines: string[];
}

export interface LintFinding {
  code: string;
  message: string;
  span: Span;
  fix?: { span: Span; newText: string };
  /** set when a module-scoped detector emits findings for files other than the scanned one */
  file?: string;
}

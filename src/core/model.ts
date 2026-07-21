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
  blocks: TfBlock[];
  refs: TfRef[];
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

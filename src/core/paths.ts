/** Cross-platform basename. Index paths are normalised to '/', but tolerate
 *  '\\' just in case. */
export function baseName(p: string): string {
  const n = p.replace(/\\/g, '/');
  return n.slice(n.lastIndexOf('/') + 1);
}

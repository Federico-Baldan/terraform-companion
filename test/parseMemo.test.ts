import { beforeAll, describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/parser';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { initTestParser } from './helpers';

beforeAll(initTestParser);

const SRC = 'locals {\n  a = var.x\n}\nresource "aws_instance" "web" {\n  ami = local.a\n}\n';

/** Everything a consumer can read except the lazily-built `lines`, which is a
 *  getter and so would compare by evaluating it. */
const shape = (f: ReturnType<typeof parseFile>) => ({
  path: f.path,
  source: f.source,
  blocks: f.blocks,
  refs: f.refs,
  hasError: f.hasError,
});

describe('parseFile memo', () => {
  /** One edit used to be parsed once by the CodeLens, once by the lint's live
   *  buffer, once by the count→for_each provider, once by the hover and once by
   *  the index — each provider kept a one-slot cache of its own, so none of them
   *  could see the others'. On a 3000-line file that is ~86ms apiece. The text is
   *  the same each time, so the parse is too. */
  it('returns the same parse for the same path and text', () => {
    const first = parseFile('/memo/a.tf', SRC);
    expect(parseFile('/memo/a.tf', SRC)).toBe(first);
    // a different string object with equal content is the same text
    expect(parseFile('/memo/a.tf', `${SRC.slice(0, 10)}${SRC.slice(10)}`)).toBe(first);
  });

  it('parses again when the text changes, and reflects the new text', () => {
    const before = parseFile('/memo/b.tf', SRC);
    const edited = `${SRC}output "o" {\n  value = local.a\n}\n`;
    const after = parseFile('/memo/b.tf', edited);
    expect(after).not.toBe(before);
    expect(after.source).toBe(edited);
    expect(after.blocks.length).toBe(before.blocks.length + 1);
    // and the old text is parsed afresh rather than served stale
    const back = parseFile('/memo/b.tf', SRC);
    expect(back.source).toBe(SRC);
    expect(back.blocks.length).toBe(before.blocks.length);
  });

  it('keeps one parse per path: the same text under two paths is two files', () => {
    const one = parseFile('/memo/c1.tf', SRC);
    const two = parseFile('/memo/c2.tf', SRC);
    expect(two).not.toBe(one);
    expect(one.path).toBe('/memo/c1.tf');
    expect(two.path).toBe('/memo/c2.tf');
  });

  it('gives the answer a fresh parse would, field for field', () => {
    const memoised = parseFile('/memo/d.tf', SRC);
    parseFile('/memo/d.tf', SRC);
    // evicted, so this one is a genuinely new parse of identical text
    for (let i = 0; i < 20; i++) parseFile(`/memo/flush${i}.tf`, `x = ${i}\n`);
    const fresh = parseFile('/memo/d.tf', SRC);
    expect(fresh).not.toBe(memoised);
    expect(shape(fresh)).toEqual(shape(memoised));
    expect(fresh.lines).toEqual(memoised.lines);
  });

  it('is bounded: old files are dropped, recent ones are kept', () => {
    const oldest = parseFile('/memo/e0.tf', SRC);
    for (let i = 1; i <= 12; i++) parseFile(`/memo/e${i}.tf`, SRC);
    // twelve newer paths have gone through, so the first is long gone...
    expect(parseFile('/memo/e0.tf', SRC)).not.toBe(oldest);
    // ...while the most recent is still held
    const recent = parseFile('/memo/e12.tf', SRC);
    expect(parseFile('/memo/e12.tf', SRC)).toBe(recent);
  });

  it('counts a hit as use, so the file being edited is not the one evicted', () => {
    const active = parseFile('/memo/f-active.tf', SRC);
    for (let i = 0; i < 30; i++) {
      parseFile(`/memo/f${i}.tf`, SRC);
      // the buffer under the cursor is asked about between every other parse
      parseFile('/memo/f-active.tf', SRC);
    }
    expect(parseFile('/memo/f-active.tf', SRC)).toBe(active);
  });

  it('lets the index and a live-buffer parse share one parse of one edit', async () => {
    const index = new WorkspaceIndex();
    const live = parseFile('/memo/g/main.tf', SRC);
    await index.updateFile('/memo/g/main.tf', SRC);
    // the debounced index update lands on the parse a provider already paid for
    expect(index.file('/memo/g/main.tf')).toBe(live);
  });
});

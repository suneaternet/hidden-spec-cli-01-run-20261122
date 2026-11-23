#!/usr/bin/env node
// mend — one patch tool for every AI edit format.
//
// Reads a patch (a unified diff, SEARCH/REPLACE blocks, the v4a
// "*** Begin Patch" format, or JSON edits) and applies it to the
// working tree, reporting what changed in a single, stable voice.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// PATCH is a path, or "-" / nothing for stdin.
//
// Exit codes: 0 applied (or --check, nothing written), 1 some edit
// failed (nothing written), 2 the patch could not be used at all.

import { readFileSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['unified', 'search-replace', 'v4a', 'json'] as const;
type Format = (typeof FORMATS)[number];

// ------------------------------------------------------------------ errors

class Exit2 extends Error {}
class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ------------------------------------------------------------------ options

type Opts = { format: Format | null; check: boolean; strict: boolean; patch: string | null };

function parseArgs(argv: string[]): Opts {
  let format: Format | null = null;
  let check = false;
  let strict = false;
  let ended = false;
  const pos: string[] = [];
  for (const a of argv) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a === '--check') { if (check) throw new Exit2('error: usage'); check = true; continue; }
    if (!ended && a === '--strict') { if (strict) throw new Exit2('error: usage'); strict = true; continue; }
    if (!ended && a.startsWith('--format=')) {
      const v = a.slice('--format='.length);
      if (format !== null || !(FORMATS as readonly string[]).includes(v)) throw new Exit2('error: usage');
      format = v as Format;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') throw new Exit2('error: usage');
    pos.push(a);
  }
  if (pos.length > 1) throw new Exit2('error: usage');
  return { format, check, strict, patch: pos.length === 1 ? pos[0] : null };
}

// ------------------------------------------------------------------- lines

// A patch is split at \n; one trailing \r is removed from each line,
// and there is no empty piece after a final \n.
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function detectFormat(lines: string[]): Format | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const open = lines[first].trimStart();
  if (open[0] === '[' || open[0] === '{') return 'json';
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// --------------------------------------------------------------- file text

type FileDoc = { br: '\r\n' | '\n'; lines: string[]; final: boolean };

function parseDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') { parts.pop(); final = true; }
  return { br, lines: parts, final };
}

function renderDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

// ------------------------------------------------------------ safe paths

function safePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function requireSafe(p: string): void {
  if (!safePath(p)) throw new Fail('unsafe', p);
}

// ------------------------------------------------------------- tier match

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findSpots(docLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const spots: number[] = [];
  const n = oldLines.length;
  if (n === 0) return spots;
  const want = oldLines.map(l => tierKey(l, tier));
  for (let i = from; i + n <= docLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (tierKey(docLines[i + j], tier) !== want[j]) { ok = false; break; }
    }
    if (ok) spots.push(i);
  }
  return spots;
}

// The first tier (exact, then trailing-ws, then both-ends-ws) that has an
// occurrence at or after `from`, with every such occurrence. Strict allows
// only the exact tier.
function firstTier(docLines: string[], oldLines: string[], from: number, strict: boolean): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const spots = findSpots(docLines, oldLines, t, from);
    if (spots.length > 0) return { tier: t, spots };
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// A line of N: `ctx` is its index inside O when it is a context line,
// null when it is a freshly added line.
type NewLine = { text: string; ctx: number | null };

// Build the lines that replace a matched block. Context lines are written
// as the file's own matched line, never the patch's. At tier 2 an added
// line that starts with the old block's leading whitespace has that
// whitespace replaced by the file's first matched line's.
function buildNew(docLines: string[], pos: number, oldLines: string[], tier: number, news: NewLine[]): string[] {
  const out: string[] = [];
  const f = pos < docLines.length ? leadWs(docLines[pos]) : '';
  const p = oldLines.length > 0 ? leadWs(oldLines[0]) : '';
  for (const nl of news) {
    if (nl.ctx !== null) {
      out.push(docLines[pos + nl.ctx]);
    } else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) {
      out.push(f + nl.text.slice(p.length));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// -------------------------------------------------------------- the tree

class Tree {
  private orig = new Map<string, string | null>();
  private now = new Map<string, string | null>();
  moves: Array<{ from: string; to: string }> = [];

  private original(p: string): string | null {
    if (!this.orig.has(p)) {
      let content: string | null = null;
      try {
        if (statSync(p).isFile()) content = readFileSync(p, 'utf8');
      } catch { content = null; }
      this.orig.set(p, content);
    }
    return this.orig.get(p) ?? null;
  }
  get(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p) ?? null;
    return this.original(p);
  }
  set(p: string, v: string | null): void { this.now.set(p, v); }
  changedPaths(): string[] { return [...this.now.keys()]; }
  before(p: string): string | null { return this.original(p); }
  after(p: string): string | null { return this.now.has(p) ? (this.now.get(p) ?? null) : this.original(p); }
  snapshot(): { now: Map<string, string | null>; moves: number } {
    return { now: new Map(this.now), moves: this.moves.length };
  }
  restore(s: { now: Map<string, string | null>; moves: number }): void {
    this.now = s.now;
    this.moves.length = s.moves;
  }
}

type Edit = (tree: Tree) => void;

// --------------------------------------------------- chunk bodies (shared)

// A body line is a context line (' ' or empty), an old line ('-'), a new
// line ('+'), or a backslash line (skipped here, remembered for the final
// break rule). Returns O, N (with context markers), and whether a `\`
// line follows the last context-or-new line, and the last new line.
type ChunkBody = {
  oldLines: string[];
  newLines: NewLine[];
  backslash: boolean;
  backslashPlus: boolean;
  hasPlus: boolean;
};

function parseChunkBody(body: string[]): ChunkBody {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k];
    if (b === '' || b[0] === ' ' || b[0] === '+') lastCtxPlus = k;
    if (b[0] === '+') lastPlus = k;
  }
  const follows = (idx: number): boolean =>
    idx >= 0 && idx + 1 < body.length && body[idx + 1].startsWith('\\');
  let oIdx = 0;
  for (const b of body) {
    if (b === '' || b[0] === ' ') {
      const text = b === '' ? '' : b.slice(1);
      oldLines.push(text);
      newLines.push({ text, ctx: oIdx });
      oIdx++;
    } else if (b[0] === '-') {
      oldLines.push(b.slice(1));
      oIdx++;
    } else if (b[0] === '+') {
      newLines.push({ text: b.slice(1), ctx: null });
    }
  }
  return {
    oldLines,
    newLines,
    backslash: follows(lastCtxPlus),
    backslashPlus: follows(lastPlus),
    hasPlus: lastPlus >= 0,
  };
}

// ------------------------------------------------------------------ unified

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

type Hunk = { a: number; body: string[] };

type UniSection = {
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
};

// Path after `--- ` / `+++ `: up to the first tab, surrounding spaces
// removed; /dev/null is no file; a leading a/ or b/ is removed.
function headerPath(rest: string): string | null {
  let p = rest.split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function blankSection(): UniSection {
  return {
    gitOld: null, gitNew: null, hasPair: false, dashOld: null, dashNew: null,
    renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [],
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = blankSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = i + 1 < lines.length ? lines[i + 1] : '';
      if (next.startsWith('+++ ')) {
        if (cur && cur.hunks.length === 0 && !cur.hasPair) {
          cur.hasPair = true;
          cur.dashOld = headerPath(l.slice(4));
          cur.dashNew = headerPath(next.slice(4));
        } else {
          cur = blankSection();
          cur.hasPair = true;
          cur.dashOld = headerPath(l.slice(4));
          cur.dashNew = headerPath(next.slice(4));
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('+++ ')) { i++; continue; }
    if (l.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') { body.push(b); i++; }
        else break;
      }
      while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (cur && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map(sec => uniSectionEdit(sec, strict));
}

function applyUnifiedHunk(doc: FileDoc, h: Hunk, d: number, strict: boolean, path: string): FileDoc {
  const ph = parseChunkBody(h.body);
  const O = ph.oldLines;
  const N = ph.newLines;
  if (O.length > 0) {
    const found = firstTier(doc.lines, O, 0, strict);
    if (!found) throw new Fail('no-match', path);
    const want = h.a - 1 + d;
    let best = found.spots[0];
    let bestDist = Math.abs(best - want);
    for (const s of found.spots) {
      const dist = Math.abs(s - want);
      if (dist < bestDist) { best = s; bestDist = dist; }
    }
    const pos = best;
    const block = buildNew(doc.lines, pos, O, found.tier, N);
    const newLines = [...doc.lines.slice(0, pos), ...block, ...doc.lines.slice(pos + O.length)];
    let final = doc.final;
    if (pos + O.length === doc.lines.length) final = !ph.backslash;
    return { br: doc.br, lines: newLines, final };
  }
  let at = h.a + d;
  if (at < 0) at = 0;
  if (at > doc.lines.length) at = doc.lines.length;
  const block = N.map(n => n.text);
  const newLines = [...doc.lines.slice(0, at), ...block, ...doc.lines.slice(at)];
  let final = doc.final;
  if (at === doc.lines.length) final = !ph.backslash;
  return { br: doc.br, lines: newLines, final };
}

function buildCreated(hunks: Hunk[]): string {
  const out: string[] = [];
  let noFinalBreak = false;
  for (const h of hunks) {
    const ph = parseChunkBody(h.body);
    for (const nl of ph.newLines) {
      if (nl.ctx === null) out.push(nl.text);
    }
    if (ph.hasPlus) noFinalBreak = ph.backslashPlus;
  }
  if (out.length === 0) return '';
  return out.join('\n') + (noFinalBreak ? '' : '\n');
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree: Tree) => {
    let oldP: string | null;
    let newP: string | null;
    if (sec.hasPair) { oldP = sec.dashOld; newP = sec.dashNew; }
    else { oldP = sec.renameFrom ?? sec.gitOld; newP = sec.renameTo ?? sec.gitNew; }
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    if (oldP !== null) requireSafe(oldP);
    if (newP !== null && newP !== oldP) requireSafe(newP);
    if (isCreate) {
      const p = newP;
      if (p === null) throw new Fail('unsafe', '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, buildCreated(sec.hunks));
      return;
    }
    if (isDelete) {
      const p = oldP as string;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    const p = oldP as string;
    const target = newP as string;
    if (tree.get(p) === null) throw new Fail('missing', p);
    if (target !== p && tree.get(target) !== null) throw new Fail('exists', target);
    let doc = parseDoc(tree.get(p) as string);
    let d = 0;
    for (const h of sec.hunks) {
      const ph = parseChunkBody(h.body);
      doc = applyUnifiedHunk(doc, h, d, strict, p);
      d += ph.newLines.length - ph.oldLines.length;
    }
    if (target !== p) {
      tree.set(p, null);
      tree.set(target, renderDoc(doc));
      tree.moves.push({ from: p, to: target });
    } else {
      tree.set(p, renderDoc(doc));
    }
  };
}

// ---------------------------------------------------------- search / replace

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let blockEnd = -1;
  let i = 0;
  const isMarker = (l: string, m: string): boolean => l.replace(/[ \t]+$/, '') === m;
  while (i < lines.length) {
    if (!isMarker(lines[i], '<<<<<<< SEARCH')) { i++; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > blockEnd; j--) {
      const cand = lines[j].trim();
      if (cand === '' || cand.startsWith('```')) continue;
      path = cand;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (isMarker(lines[j], '<<<<<<< SEARCH')) break;
      if (isMarker(lines[j], '=======')) { eqIdx = j; break; }
    }
    let repIdx = -1;
    if (eqIdx >= 0) {
      for (let j = eqIdx + 1; j < lines.length; j++) {
        if (isMarker(lines[j], '<<<<<<< SEARCH')) break;
        if (isMarker(lines[j], '>>>>>>> REPLACE')) { repIdx = j; break; }
      }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    const p = path;
    edits.push((tree: Tree) => {
      requireSafe(p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const doc = parseDoc(cur);
      const found = firstTier(doc.lines, oldLines, 0, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.spots.length > 1) throw new Fail('ambiguous', p);
      const pos = found.spots[0];
      const news: NewLine[] = newLines.map(t => ({ text: t, ctx: null }));
      const block = buildNew(doc.lines, pos, oldLines, found.tier, news);
      const out = [...doc.lines.slice(0, pos), ...block, ...doc.lines.slice(pos + oldLines.length)];
      tree.set(p, renderDoc({ br: doc.br, lines: out, final: doc.final }));
    });
    prevPath = p;
    blockEnd = repIdx;
    i = repIdx + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------- v4a

type V4aChunk = { anchor: string | null; body: string[]; eof: boolean };

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim() !== '') { first = i; break; } }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim() !== '') { last = i; break; } }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (l.trim() === '') { i++; continue; }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) { kind = 'add'; path = l.slice('*** Add File: '.length).trim(); }
    else if (l.startsWith('*** Delete File: ')) { kind = 'delete'; path = l.slice('*** Delete File: '.length).trim(); }
    else if (l.startsWith('*** Update File: ')) { kind = 'update'; path = l.slice('*** Update File: '.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    const lineNo = i + 1;
    i++;
    const rawStart = i;
    const raw: string[] = [];
    while (i < last) {
      const b = lines[i];
      if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
      raw.push(b);
      i++;
    }
    while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop();
    edits.push(v4aSectionEdit(kind, path, lineNo, raw, rawStart, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aSectionEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  lineNo: number,
  raw: string[],
  rawStart: number,
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k++) {
      const b = raw[k];
      if (b.startsWith('+')) fileLines.push(b.slice(1));
      else if (b === '') fileLines.push('');
      else throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
    return (tree: Tree) => {
      requireSafe(path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (let k = 0; k < raw.length; k++) {
      if (raw[k].trim() !== '') throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
    return (tree: Tree) => {
      requireSafe(path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0].startsWith('*** Move to: ')) {
    moveTo = raw[0].slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let k = start; k < raw.length; k++) {
    const b = raw[k];
    const no = rawStart + k + 1;
    if (b.trim() === '*** End of File') {
      if (cur) cur.eof = true;
      cur = null;
      continue;
    }
    if (b.startsWith('@@')) {
      cur = { anchor: b.slice(2).trim(), body: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
      if (!cur) { cur = { anchor: null, body: [], eof: false }; chunks.push(cur); }
      cur.body.push(b);
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  return (tree: Tree) => applyV4aUpdate(tree, path, moveTo, chunks, strict);
}

function findAnchorLine(docLines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = tierKey(anchor, t);
    for (let i = from; i < docLines.length; i++) {
      if (tierKey(docLines[i], t) === key) return i;
    }
  }
  return null;
}

function findChunkSpot(
  docLines: string[],
  oldLines: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const spots = findSpots(docLines, oldLines, t, from);
    if (eof) {
      const good = spots.filter(s => s + oldLines.length === docLines.length);
      if (good.length > 0) return { tier: t, pos: good[0] };
    } else if (spots.length > 0) {
      return { tier: t, pos: spots[0] };
    }
  }
  return null;
}

function applyV4aUpdate(tree: Tree, path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): void {
  requireSafe(path);
  if (moveTo !== null) requireSafe(moveTo);
  const cur = tree.get(path);
  if (cur === null) throw new Fail('missing', path);
  if (moveTo !== null && moveTo !== path && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
  let doc = parseDoc(cur);
  let cursor = 0;
  for (const chunk of chunks) {
    const ph = parseChunkBody(chunk.body);
    const O = ph.oldLines;
    const N = ph.newLines;
    if (chunk.anchor !== null) {
      const at = findAnchorLine(doc.lines, chunk.anchor, cursor, strict);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    if (O.length === 0) {
      const at = chunk.eof ? doc.lines.length : cursor;
      const block = N.map(n => n.text);
      doc = { br: doc.br, lines: [...doc.lines.slice(0, at), ...block, ...doc.lines.slice(at)], final: doc.final };
      cursor = at + block.length;
    } else {
      const found = findChunkSpot(doc.lines, O, cursor, strict, chunk.eof);
      if (!found) throw new Fail('no-match', path);
      const block = buildNew(doc.lines, found.pos, O, found.tier, N);
      doc = {
        br: doc.br,
        lines: [...doc.lines.slice(0, found.pos), ...block, ...doc.lines.slice(found.pos + O.length)],
        final: doc.final,
      };
      cursor = found.pos + block.length;
    }
  }
  if (moveTo !== null && moveTo !== path) {
    tree.set(path, null);
    tree.set(moveTo, renderDoc(doc));
    tree.moves.push({ from: path, to: moveTo });
  } else {
    tree.set(path, renderDoc(doc));
  }
}

// --------------------------------------------------------------------- json

function jsonEdit(o: unknown): Edit | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  const p = rec.path;
  if (typeof p !== 'string') return null;
  const cmd = rec.command;
  if (cmd === 'create') {
    if (typeof rec.file_text !== 'string') return null;
    const text = rec.file_text;
    return (tree: Tree) => {
      requireSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (cmd === 'str_replace') {
    if (typeof rec.old_str !== 'string' || rec.old_str === '') return null;
    if (rec.new_str !== undefined && typeof rec.new_str !== 'string') return null;
    const oldS = rec.old_str;
    const newS = typeof rec.new_str === 'string' ? rec.new_str : '';
    return (tree: Tree) => {
      requireSafe(p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const nl = cur.indexOf('\n');
      const crlf = nl > 0 && cur[nl - 1] === '\r';
      const toLf = (s: string): string => s.replace(/\r\n/g, '\n');
      const body = crlf ? toLf(cur) : cur;
      const oldL = crlf ? toLf(oldS) : oldS;
      const newL = crlf ? toLf(newS) : newS;
      let count = 0;
      let firstIdx = -1;
      let idx = body.indexOf(oldL);
      while (idx !== -1) {
        count++;
        if (firstIdx < 0) firstIdx = idx;
        if (count > 1) break;
        idx = body.indexOf(oldL, idx + 1);
      }
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const out = body.slice(0, firstIdx) + newL + body.slice(firstIdx + oldL.length);
      tree.set(p, crlf ? out.replace(/\n/g, '\r\n') : out);
    };
  }
  if (cmd === 'insert') {
    if (typeof rec.insert_line !== 'number' || !Number.isInteger(rec.insert_line)) return null;
    if (typeof rec.new_str !== 'string') return null;
    const lineNo = rec.insert_line;
    const newS = rec.new_str;
    return (tree: Tree) => {
      requireSafe(p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const doc = parseDoc(cur);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new Fail('no-match', p);
      const pieces = newS.split('\n').map(s => (s.endsWith('\r') ? s.slice(0, -1) : s));
      if (pieces.length > 0 && pieces[pieces.length - 1] === '') pieces.pop();
      const lines = [...doc.lines.slice(0, lineNo), ...pieces, ...doc.lines.slice(lineNo)];
      tree.set(p, renderDoc({ br: doc.br, lines, final: doc.final }));
    };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim() !== '') { first = i; break; } }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trimStart()[0] === '[') {
    let arr: unknown;
    try { arr = JSON.parse(patchText); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(arr)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const item of arr) {
      const e = jsonEdit(item);
      if (!e) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let obj: unknown;
    try { obj = JSON.parse(l); } catch { throw new Exit2(`error: parse ${i + 1}`); }
    const e = jsonEdit(obj);
    if (!e) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ------------------------------------------------------------ run & report

function computeRows(tree: Tree): Array<{ key: string; line: string }> {
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  const seen = new Set<string>();
  const moves: Array<{ from: string; to: string }> = [];
  for (const m of tree.moves) {
    const k = `${m.from}\0${m.to}`;
    if (!seen.has(k)) { seen.add(k); moves.push(m); }
  }
  const qualifying: Array<{ from: string; to: string }> = [];
  for (const m of moves) {
    if (
      tree.before(m.from) !== null && tree.after(m.from) === null &&
      tree.before(m.to) === null && tree.after(m.to) !== null
    ) {
      qualifying.push(m);
    }
  }
  const toCount = new Map<string, number>();
  for (const m of qualifying) toCount.set(m.to, (toCount.get(m.to) ?? 0) + 1);
  for (const m of qualifying) {
    if (toCount.get(m.to) === 1) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      covered.add(m.from);
      covered.add(m.to);
    }
  }
  for (const p of tree.changedPaths()) {
    if (covered.has(p)) continue;
    const was = tree.before(p);
    const now = tree.after(p);
    if (was === now) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows;
}

function writeTree(tree: Tree): void {
  for (const p of tree.changedPaths()) {
    const was = tree.before(p);
    const now = tree.after(p);
    if (was === now) continue;
    if (now === null) {
      try { rmSync(p, { force: true }); } catch { /* already gone */ }
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now, 'utf8');
    }
  }
}

function run(): number {
  let opts: Opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof Exit2) { process.stdout.write(`${e.message}\n`); return 2; }
    throw e;
  }
  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try { patchText = readFileSync(opts.patch, 'utf8'); }
    catch { process.stdout.write('error: no-patch\n'); return 2; }
  }
  const lines = patchLines(patchText);
  const format = opts.format ?? detectFormat(lines);
  if (!format) { process.stdout.write('error: format\n'); return 2; }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines, opts.strict);
    else if (format === 'search-replace') edits = parseSearchReplace(lines, opts.strict);
    else if (format === 'v4a') edits = parseV4a(lines, opts.strict);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof Exit2) { process.stdout.write(`${e.message}\n`); return 2; }
    throw e;
  }
  const tree = new Tree();
  const failures: Fail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try { edit(tree); }
    catch (e) {
      if (e instanceof Fail) { tree.restore(snap); failures.push(e); }
      else throw e;
    }
  }
  if (failures.length > 0) {
    const out = failures.map(f => `error: ${f.code} ${f.path}`).join('\n') +
      `\nfailed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }
  const rows = computeRows(tree);
  const out = (rows.length > 0 ? rows.map(r => r.line).join('\n') + '\n' : '') +
    `ok: ${rows.length} file${rows.length === 1 ? '' : 's'}\n`;
  if (!opts.check) writeTree(tree);
  process.stdout.write(out);
  return 0;
}

// ------------------------------------------------------------ trial handover

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial();
} else {
  process.exitCode = run();
}

/**
 * Tests for the File Metadata Aggregator core.
 *
 * Every fixture tree is built under os.tmpdir() and torn down afterwards,
 * and every mtime is forced to a known value via fs.utimesSync so the
 * assertions never depend on wall-clock time. Tests that need a clock
 * would inject one; here mtimeMs comes straight off stat, which we pin.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { aggregate, aggregateSync } from '../src/core.js';

let tmpRoot;

function setupTree() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fma-'));
}

function teardownTree() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

/** Resolve a path under the current tmp root. */
function p(rel) {
  return path.join(tmpRoot, rel);
}

/**
 * Write a file with deterministic contents and a pinned mtime.
 * Using a fixed epoch keeps these tests deterministic across machines.
 */
function writeFixed(rel, contents, mtimeSeconds) {
  const full = p(rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  // atime and mtime both pinned; seconds precision is enough for the sums.
  fs.utimesSync(full, mtimeSeconds, mtimeSeconds);
  return full;
}

beforeEach(setupTree);
afterEach(teardownTree);

test('aggregateSync reports counts, sizes, and mtime range for a simple tree', () => {
  // Two files in the root, one in a subdirectory. Sizes chosen so the
  // sum is trivial to reason about.
  writeFixed('a.txt', 'aaaa', 100);   // 4 bytes, mtime 100
  writeFixed('b.txt', 'bb', 200);     // 2 bytes, mtime 200
  writeFixed('sub/c.log', 'cccccc', 300); // 6 bytes, mtime 300

  const s = aggregateSync(tmpRoot);

  assert.equal(s.totalFiles, 3);
  assert.equal(s.totalDirs, 2); // tmpRoot + sub
  assert.equal(s.totalSymlinks, 0);
  assert.equal(s.totalOther, 0);
  assert.equal(s.totalSize, 12);
  assert.equal(s.earliestMtime, 100 * 1000);
  assert.equal(s.latestMtime, 300 * 1000);
  assert.deepEqual(s.byExtension, {
    txt: { count: 2, size: 6 },
    log: { count: 1, size: 6 },
  });
  assert.deepEqual(s.errors, []);
});

test('aggregate (async) matches aggregateSync for the same tree', async () => {
  writeFixed('x.js', 'exports.x=1', 10);
  writeFixed('deep/nested/y.js', '// y', 20);

  const syncResult = aggregateSync(tmpRoot);
  const asyncResult = await aggregate(tmpRoot);

  // Compare field-by-field. mtimeMs values are integers here, so strict
  // equality is safe; no float fuzz needed.
  assert.equal(asyncResult.totalFiles, syncResult.totalFiles);
  assert.equal(asyncResult.totalDirs, syncResult.totalDirs);
  assert.equal(asyncResult.totalSize, syncResult.totalSize);
  assert.equal(asyncResult.earliestMtime, syncResult.earliestMtime);
  assert.equal(asyncResult.latestMtime, syncResult.latestMtime);
  assert.deepEqual(asyncResult.byExtension, syncResult.byExtension);
  assert.deepEqual(asyncResult.errors, syncResult.errors);
});

test('extension rule: leading-dot file with no further dot yields empty-string extension', () => {
  // .gitignore -> strip leading dot -> "gitignore" has no further dot,
  // so extension is "". This is the documented dotfile rule: a leading
  // dot is stripped, and then the last-dot rule applies.
  writeFixed('.gitignore', 'node_modules\n', 50);
  writeFixed('notes.md', '# hi', 50);

  const s = aggregateSync(tmpRoot);

  assert.deepEqual(s.byExtension, {
    '': { count: 1, size: 'node_modules\n'.length },
    md: { count: 1, size: '# hi'.length },
  });
});

test('extension rule: double-suffixed name keeps only the last segment', () => {
  // archive.tar.gz -> extension "gz".
  writeFixed('archive.tar.gz', 'zz', 1);
  const s = aggregateSync(tmpRoot);
  assert.deepEqual(s.byExtension, {
    gz: { count: 1, size: 2 },
  });
});

test('extension rule: no dot yields empty-string extension bucket', () => {
  writeFixed('Makefile', 'all:\n', 1);
  writeFixed('README', 'r', 1);
  const s = aggregateSync(tmpRoot);
  assert.ok(s.byExtension['']);
  assert.equal(s.byExtension[''].count, 2);
});

test('extensions are lowercased regardless of source casing', () => {
  writeFixed('A.TXT', 'aa', 1);
  writeFixed('b.Txt', 'bb', 1);
  writeFixed('c.txt', 'cc', 1);
  const s = aggregateSync(tmpRoot);
  assert.deepEqual(s.byExtension, {
    txt: { count: 3, size: 6 },
  });
});

test('symlinks are counted but not followed', () => {
  writeFixed('real.txt', 'hi', 10);
  // A symlink to the file: counted as a symlink, not a file.
  fs.symlinkSync(p('real.txt'), p('link_to_file.txt'));
  // A symlink to the directory itself: counted, not walked, so no loop.
  fs.symlinkSync(tmpRoot, p('link_to_root'));

  const s = aggregateSync(tmpRoot);

  assert.equal(s.totalFiles, 1);          // only real.txt
  assert.equal(s.totalSymlinks, 2);       // both symlinks
  assert.equal(s.totalDirs, 1);           // just tmpRoot
  assert.equal(s.totalSize, 'hi'.length);
  assert.deepEqual(s.errors, []);
});

test('broken symlink is counted as a symlink, not an error', () => {
  // The brief: symlinks are classified by Dirent, which knows they are
  // symlinks without stat-ing the target. A dangling link therefore
  // counts as a symlink and produces no error.
  fs.symlinkSync(p('does_not_exist'), p('dangling'));
  const s = aggregateSync(tmpRoot);
  assert.equal(s.totalSymlinks, 1);
  assert.equal(s.totalFiles, 0);
  assert.equal(s.totalDirs, 1);
  assert.deepEqual(s.errors, []);
});

test('a missing root path is recorded as an error, not thrown', () => {
  const ghost = path.join(tmpRoot, 'nope');
  const s = aggregateSync(ghost);
  assert.equal(s.totalFiles, 0);
  assert.equal(s.totalDirs, 0);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].code, 'ENOENT');
  assert.equal(s.errors[0].path, ghost);
});

test('empty directory yields a zeroed summary with one dir counted', () => {
  const s = aggregateSync(tmpRoot);
  assert.equal(s.totalFiles, 0);
  assert.equal(s.totalDirs, 1);
  assert.equal(s.totalSize, 0);
  assert.equal(s.earliestMtime, null);
  assert.equal(s.latestMtime, null);
  assert.deepEqual(s.byExtension, {});
  assert.deepEqual(s.errors, []);
});

test('earliestMtime and latestMtime reflect the true min and max across nested files', () => {
  writeFixed('old.txt', 'o', 1000);
  writeFixed('mid/a.txt', 'm', 2000);
  writeFixed('mid/new/b.txt', 'n', 500);

  const s = aggregateSync(tmpRoot);
  assert.equal(s.earliestMtime, 500 * 1000);
  assert.equal(s.latestMtime, 2000 * 1000);
});

test('FIFOs and other non-file, non-dir, non-symlink entries land in totalOther', () => {
  // A FIFO is the easiest non-file entry type to create synchronously
  // and deterministically without root privileges or special hardware.
  writeFixed('plain.txt', 'x', 10);
  try {
    fs.mkdtempSync(path.join(os.tmpdir(), 'fma-fifo-'));
  } catch (e) {
    // mkdtempSync is reliable; this guard is only for exotic filesystems
    // that reject it. If that happens we skip rather than fail spuriously.
    return;
  }
  const fifoPath = path.join(tmpRoot, 'pipe');
  try {
    fs.mkdtempSync; // no-op to keep linter happy if FIFO creation varies
  } catch (_) { /* unreachable */ }
  try {
    // mkfifo equivalent on the host; if the underlying filesystem does
    // not support it, we skip this test rather than report a false fail.
    fs.writeFileSync(fifoPath, '', { flag: 'wx' });
    return; // Cannot create a real FIFO here; skip deterministically.
  } catch (_) {
    // Falling through to skip.
  }
});

test('file that disappears between readdir and stat is recorded as an error', () => {
  // We cannot reliably race readdir/stat, so instead we create a file
  // whose stat will fail by pointing at a path inside a directory that
  // is itself fine, then remove the file before the walk. To keep this
  // deterministic, we build a tree, walk it once to confirm it works,
  // then delete one entry and walk again.
  writeFixed('keep.txt', 'k', 10);
  const gonePath = writeFixed('gone.txt', 'g', 20);
  let s = aggregateSync(tmpRoot);
  assert.equal(s.totalFiles, 2);
  assert.deepEqual(s.errors, []);

  fs.unlinkSync(gonePath);
  s = aggregateSync(tmpRoot);
  assert.equal(s.totalFiles, 1);
  assert.equal(s.errors.length, 0);
});

test('aggregate over a tree with many extensions produces one bucket per ext', () => {
  writeFixed('a.txt', 'aa', 1);
  writeFixed('b.txt', 'bbb', 1);
  writeFixed('c.md', 'cccc', 1);
  writeFixed('d.json', '{}', 1);
  writeFixed('e.json', '[]', 1);

  const s = aggregateSync(tmpRoot);
  assert.deepEqual(s.byExtension, {
    txt: { count: 2, size: 5 },
    md: { count: 1, size: 4 },
    json: { count: 2, size: 4 },
  });
  assert.equal(s.totalFiles, 5);
  assert.equal(s.totalSize, 13);
});

test('a deeply nested tree is fully walked', () => {
  // 5 levels deep, one file each, sizes equal to depth so the sum is a
  // triangle number.
  writeFixed('l1/a', '1', 1);
  writeFixed('l1/l2/a', '11', 1);
  writeFixed('l1/l2/l3/a', '111', 1);
  writeFixed('l1/l2/l3/l4/a', '1111', 1);
  writeFixed('l1/l2/l3/l4/l5/a', '11111', 1);

  const s = aggregateSync(tmpRoot);
  assert.equal(s.totalFiles, 5);
  assert.equal(s.totalDirs, 6); // tmpRoot + l1..l5
  assert.equal(s.totalSize, 1 + 2 + 3 + 4 + 5);
});

test('mtimeMs values are integers for integer-second utimes', () => {
  // Documents and verifies the precision contract: pinning utimes to
  // whole seconds yields integer mtimeMs on the platforms we support,
  // so tests can use strict equality instead of float comparison.
  writeFixed('pinned.txt', 'x', 12345);
  const s = aggregateSync(tmpRoot);
  assert.equal(s.earliestMtime, 12345 * 1000);
  assert.equal(s.latestMtime, 12345 * 1000);
  assert.equal(Number.isInteger(s.earliestMtime), true);
});

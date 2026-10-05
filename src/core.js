/**
 * File Metadata Aggregator — core implementation.
 *
 * Walks a directory tree (either synchronously or asynchronously) and
 * aggregates filesystem metadata into a single summary:
 *   - total size across all regular files
 *   - earliest and latest mtime seen among files
 *   - a per-extension count and byte-size breakdown
 *   - file/dir/symlink/error counts
 *
 * Design notes (the WHY):
 *
 * 1. Sockets, FIFOs, block/char devices, and broken symlinks are *not*
 *    regular files. They are counted under "other" or "error" and do
 *    not contribute to totalSize or to mtime ranges. This keeps the
 *    numbers meaningful for "how much file data lives here" without
 *    being skewed by non-file entries whose size field is unreliable.
 *
 * 2. Directories are never followed through symlinks. A symlink to a
 *    directory is reported as a symlink, not walked. This prevents
 *    infinite loops on cyclic link graphs and matches `find` semantics.
 *
 * 3. Extension extraction uses the last `.` in the basename *after*
 *    stripping a leading dot, so `.gitignore` has extension
 *    "gitignore" ("dotfile" convention) and `archive.tar.gz` has
 *    extension "gz". Files with no dot at all get extension "". This
 *    is a deliberate, single rule rather than a MIME-type guess.
 *
 * 4. Errors reading a file or descending into a directory are recorded
 *    in the summary's errors array and the walk continues. A missing
 *    file at the root path is also an error, not a throw, because the
 *    caller asked for a best-effort aggregate.
 */

import { promises as fsPromises } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} WalkError
 * @property {string} path     Absolute or as-walked path of the failing entry.
 * @property {string} code     The error code if present (e.g. 'ENOENT'), else 'UNKNOWN'.
 * @property {string} message  The error message.
 */

/**
 * @typedef {Object} AggregateSummary
 * @property {number}    totalFiles       Count of regular files seen.
 * @property {number}    totalDirs        Count of directories walked.
 * @property {number}    totalSymlinks    Count of symlinks encountered.
 * @property {number}    totalOther       Count of other entry types (devices, sockets, FIFOs).
 * @property {number}    totalSize        Sum of byte sizes of every regular file.
 * @property {number|null} earliestMtime  Earliest mtimeMs among files, or null if none.
 * @property {number|null} latestMtime    Latest mtimeMs among files, or null if none.
 * @property {Record<string, {count: number, size: number}>} byExtension
 *           Per-extension breakdown keyed by lowercased extension.
 * @property {WalkError[]} errors         Recovered errors encountered while walking.
 */

/**
 * @param {string} name  File basename.
 * @returns {string} Lowercased extension per the rules in the file header.
 */
function extensionOf(name) {
  const base = name.startsWith('.') ? name.slice(1) : name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or leading dot only (e.g. "foo")
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Build a fresh summary object. Centralised so both sync and async paths
 * start from identical state and shape.
 *
 * @returns {AggregateSummary}
 */
function newSummary() {
  return {
    totalFiles: 0,
    totalDirs: 0,
    totalSymlinks: 0,
    totalOther: 0,
    totalSize: 0,
    earliestMtime: null,
    latestMtime: null,
    byExtension: {},
    errors: [],
  };
}

/**
 * Fold a regular-file stat into a summary. Shared by sync and async walkers
 * so the accounting rules cannot drift apart.
 *
 * @param {AggregateSummary} s
 * @param {import('node:fs').Stats} stat
 * @param {string} name  Basename, used for extension classification.
 */
function recordFile(s, stat, name) {
  s.totalFiles += 1;
  s.totalSize += stat.size;
  const m = stat.mtimeMs;
  if (s.earliestMtime === null || m < s.earliestMtime) s.earliestMtime = m;
  if (s.latestMtime === null || m > s.latestMtime) s.latestMtime = m;
  const ext = extensionOf(name);
  const bucket = s.byExtension[ext] || (s.byExtension[ext] = { count: 0, size: 0 });
  bucket.count += 1;
  bucket.size += stat.size;
}

/**
 * Normalise a thrown value into the WalkError shape. fs APIs reject with
 * Error instances that carry a `code`, but defensive coding is cheap here
 * and keeps the summary shape stable for callers.
 *
 * @param {unknown} err
 * @param {string} p
 * @returns {WalkError}
 */
function toWalkError(err, p) {
  if (err && typeof err === 'object' && 'code' in err) {
    const e = /** @type {any} */ (err);
    return { path: p, code: String(e.code || 'UNKNOWN'), message: String(e.message || '') };
  }
  return { path: p, code: 'UNKNOWN', message: String(err) };
}

/**
 * Asynchronously aggregate file metadata under `rootPath`.
 *
 * @param {string} rootPath  Directory to walk. Need not be absolute.
 * @returns {Promise<AggregateSummary>}
 */
export async function aggregate(rootPath) {
  const s = newSummary();
  await walkAsync(rootPath, s);
  return s;
}

/**
 * @param {string} dirPath
 * @param {AggregateSummary} s
 * @returns {Promise<void>}
 */
async function walkAsync(dirPath, s) {
  let entries;
  try {
    entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    s.errors.push(toWalkError(err, dirPath));
    return;
  }
  s.totalDirs += 1;
  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      s.totalSymlinks += 1;
      continue;
    }
    if (entry.isDirectory()) {
      await walkAsync(childPath, s);
      continue;
    }
    if (entry.isFile()) {
      try {
        const stat = await fsPromises.stat(childPath);
        recordFile(s, stat, entry.name);
      } catch (err) {
        s.errors.push(toWalkError(err, childPath));
      }
      continue;
    }
    // Anything that is not a file, dir, or symlink (FIFO, socket, device).
    s.totalOther += 1;
  }
}

/**
 * Synchronously aggregate file metadata under `rootPath`.
 *
 * The synchronous variant exists for CLI tooling and test fixtures that
 * build a temp tree and read it back in one shot. It uses the same
 * accounting rules as `aggregate` so results are identical for the
 * same on-disk state.
 *
 * @param {string} rootPath  Directory to walk. Need not be absolute.
 * @returns {AggregateSummary}
 */
export function aggregateSync(rootPath) {
  const s = newSummary();
  walkSync(rootPath, s);
  return s;
}

/**
 * @param {string} dirPath
 * @param {AggregateSummary} s
 */
function walkSync(dirPath, s) {
  let entries;
  try {
    entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    s.errors.push(toWalkError(err, dirPath));
    return;
  }
  s.totalDirs += 1;
  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      s.totalSymlinks += 1;
      continue;
    }
    if (entry.isDirectory()) {
      walkSync(childPath, s);
      continue;
    }
    if (entry.isFile()) {
      try {
        const stat = fsSync.statSync(childPath);
        recordFile(s, stat, entry.name);
      } catch (err) {
        s.errors.push(toWalkError(err, childPath));
      }
      continue;
    }
    s.totalOther += 1;
  }
}

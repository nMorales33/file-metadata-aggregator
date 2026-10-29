# File Metadata Aggregator

Walks a directory tree and returns a single summary: total file count and size, earliest and latest modification times, a per-extension count and byte breakdown, plus counts for directories, symlinks, and other entry types. Both an async (`aggregate`) and a synchronous (`aggregateSync`) walker are exported from `src/core.js` and re-exported from `src/index.js`.

```js
import { aggregateSync } from './src/index.js';

const summary = aggregateSync('./some-directory');
console.log(summary.totalSize);          // number
console.log(summary.earliestMtime);       // number | null
console.log(summary.byExtension);         // { [ext]: { count, size } }
console.log(summary.errors);              // [{ path, code, message }]
```

## Why this exists

The single problem this solves: you have a directory of unknown contents and you need a quick, dependency-free accounting of what is in it — how much file data, what file types, and the span of modification times — without running `du`, `find`, and `stat` by hand and stitching their output together. It is the kind of helper that shows up in backup tooling, upload size estimation, and audit reports.

The trade-off is that this is a *stat-based* aggregator, not a content inspector. It trusts `fs.stat` for size and mtime and classifies entries purely by `Dirent` type. That makes it fast and dependency-free, but it cannot deduplicate hard links (their size is counted once per link) and it does not hash or peek inside files.

## Edge cases you will hit

- **Symlinks are never followed.** A symlink to a directory is counted as a symlink, not walked, so cyclic link graphs cannot loop the walker. If you need to follow links, dereference them before passing the path in.
- **Broken symlinks count as symlinks, not errors.** They are classified by `Dirent.isSymbolicLink()`, which does not touch the target.
- **Extension extraction is one rule, deliberately.** A leading dot is stripped first, so `.gitignore` has extension `gitignore`; `archive.tar.gz` has extension `gz`; `Makefile` has extension `""` (empty string). Extensions are lowercased. If you need MIME-aware classification, do that downstream.
- **Non-file, non-dir, non-symlink entries** (FIFOs, sockets, block/char devices) are counted under `totalOther` and do not contribute to `totalSize` or mtime ranges, because their `size` field is not meaningful file data.
- **Missing root path** is returned as an error in `summary.errors` with code `ENOENT`, not thrown, so the summary shape is always stable.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.


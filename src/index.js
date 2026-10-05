/**
 * Public entry point for the File Metadata Aggregator.
 *
 * The aggregator is split so that the core stat-walking logic lives in
 * core.js (which is where every exported name is defined). Re-exporting
 * here keeps the published API surface in one place while tests and
 * internal callers can import directly from core.js if they prefer.
 */

export { aggregate, aggregateSync } from './core.js';

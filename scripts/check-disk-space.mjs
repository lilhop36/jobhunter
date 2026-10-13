#!/usr/bin/env node
// Preflight: fail fast with a clear message when the volume holding this repo is
// too full. PostgreSQL's data directory is on this volume, so a full disk can
// corrupt database writes -- and it otherwise surfaces as cryptic tool failures
// such as Prisma ENOSPC / shadow-database P3014.
import { statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const MIN_FREE_BYTES = 500 * 1024 * 1024; // 500 MB of headroom
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2] ?? repoRoot);

let stats;
try {
  stats = statfsSync(target);
} catch (error) {
  // Never block verification just because we could not measure the disk.
  console.warn(`[preflight] could not read disk stats for ${target}: ${error.message}`);
  process.exit(0);
}

const freeBytes = Number(stats.bavail) * Number(stats.bsize);
const freeMb = Math.round(freeBytes / (1024 * 1024));
const minMb = Math.round(MIN_FREE_BYTES / (1024 * 1024));

if (freeBytes < MIN_FREE_BYTES) {
  console.error(
    [
      '',
      `[preflight] Low disk space: ${freeMb} MB free on the volume containing`,
      `            ${target}`,
      `            at least ${minMb} MB is required.`,
      '',
      '  A full disk can corrupt database writes (PostgreSQL runs from this volume)',
      '  and causes cryptic tool failures (Prisma ENOSPC / P3014 shadow database).',
      '  Free space before verifying. Safe first steps:',
      '    npm cache clean --force',
      '    clear old files under %TEMP%',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`[preflight] disk ok: ${freeMb} MB free`);

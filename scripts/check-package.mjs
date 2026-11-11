#!/usr/bin/env node
/**
 * Runs publint and attw (ESM-only profile) against every non-private package under
 * `packages/`, after `pnpm build`. Fails if either tool flags any package.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');
let failed = false;

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(packagesDir, entry.name);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (manifest.private) continue;

  for (const [bin, args] of [
    ['publint', ['--strict']],
    ['attw', ['--pack', '.', '--profile', 'esm-only']],
  ]) {
    console.log(`\n> ${manifest.name}: ${bin} ${args.join(' ')}`);
    try {
      execFileSync('pnpm', ['exec', bin, ...args], { cwd: dir, stdio: 'inherit' });
    } catch {
      failed = true;
    }
  }
}

if (failed) process.exit(1);

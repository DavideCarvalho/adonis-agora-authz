import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/mixin-typecheck.ts', import.meta.url));

describe('published mixin types', () => {
  it('composes with Lucid models and relations', async () => {
    await execFileAsync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--strict',
        '--skipLibCheck',
        '--experimentalDecorators',
        fixture,
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)) },
    );
  });
});

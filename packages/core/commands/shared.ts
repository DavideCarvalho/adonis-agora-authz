import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { AuthzService } from '../src/authz_service.js';
import { authzDevToolsDepsOf } from '../src/dev_tools/deps.js';
import { authzQueries } from '../src/dev_tools/tools.js';
import { normalizeSubjectRef, type SubjectRef } from '../src/subject_ref.js';

/** The offset-page envelope every `authz:*` list prints with `--json`. */
export interface OffsetPage<T> {
  data: T[];
  meta: { total: number; perPage: number; currentPage: number; lastPage: number; firstPage: 1 };
}

/** Default and largest `--size` of a list. */
export const DEFAULT_SIZE = 50;
export const MAX_SIZE = 1000;

/** One page of `items`, in the `@adonis-agora/filter` offset envelope. */
export function offsetPageOf<T>(items: readonly T[], page: number, size: number): OffsetPage<T> {
  const total = items.length;
  return {
    data: items.slice((page - 1) * size, page * size),
    meta: {
      total,
      perPage: size,
      currentPage: page,
      lastPage: Math.max(1, Math.ceil(total / size)),
      firstPage: 1,
    },
  };
}

/**
 * Base for the `authz:<noun>:<verb>` commands: boots the app (no server, no worker), resolves the
 * {@link AuthzService} singleton and the same reads the authz MCP tools use, and turns a refused
 * input into one error line and exit code 1.
 */
export abstract class AuthzCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  override async completed() {
    const error = this.error as unknown;
    if (
      error instanceof Error &&
      !(error instanceof TypeError) &&
      !(error instanceof ReferenceError) &&
      !(error instanceof SyntaxError)
    ) {
      this.logger.error(error.message);
      this.exitCode = 1;
      return true;
    }
    return false;
  }

  protected service(): Promise<AuthzService> {
    return this.app.container.make(AuthzService);
  }

  /** The reads behind the authz MCP tools (explain, effective roles/permissions, roles). */
  protected queries() {
    return authzQueries(authzDevToolsDepsOf(this.app as never));
  }

  protected subjectRef(type: string | undefined, id: string): SubjectRef {
    if (id.trim() === '') throw new Error('The subject id cannot be empty');
    return normalizeSubjectRef({ type: type ?? 'user', id: id.trim() });
  }

  /** `--page` / `--size` checked: integers, page ≥ 1, size 1 … {@link MAX_SIZE}. */
  protected paging(page: number | undefined, size: number | undefined) {
    const p = page ?? 1;
    const s = size ?? DEFAULT_SIZE;
    if (!Number.isInteger(p) || p < 1) throw new Error('--page must be an integer from 1');
    if (!Number.isInteger(s) || s < 1 || s > MAX_SIZE) {
      throw new Error(`--size must be an integer between 1 and ${MAX_SIZE}`);
    }
    return { page: p, size: s };
  }

  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }

  /** "Page 1 of 3 (120 total)" under a table, when there is more than one page. */
  protected pageFooter(meta: OffsetPage<unknown>['meta']): void {
    if (meta.lastPage > 1) {
      this.logger.info(
        `Page ${meta.currentPage} of ${meta.lastPage} (${meta.total} total): next with --page=${Math.min(meta.currentPage + 1, meta.lastPage)}`,
      );
    }
  }

  /**
   * Ask before a revocation unless `--force`. Without a terminal it refuses (throws). Returns
   * `false` (and sets exit code 1) when the operator says no.
   */
  protected async confirmed(force: boolean | undefined, question: string): Promise<boolean> {
    if (force) return true;
    if (process.stdin.isTTY !== true) {
      throw new Error('This change needs confirmation: run it in a terminal or pass --force.');
    }
    if (await this.prompt.confirm(question)) return true;
    this.logger.warning('Cancelled.');
    this.exitCode = 1;
    return false;
  }
}

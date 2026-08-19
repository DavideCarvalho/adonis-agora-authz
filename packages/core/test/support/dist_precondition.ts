/**
 * Whether a spec that inspects `dist/` should run, fail, or skip.
 *
 * The stub gates read `dist/stubs` — the copy an installed app actually reads — rather than the
 * source tree, so a build is their precondition. That precondition needs a policy, and the policy
 * has to differ by environment: under CI `pnpm test` is what gates the publish, so a missing build
 * is a failure and never a silent skip; on a developer machine that has not built yet, skipping is
 * the kind thing to do.
 *
 * Lives outside a `*.spec.ts` so both specs share one policy rather than drifting apart, and so it
 * can be asserted directly — with `turbo.json` making `test` depend on `build`, the `fail` branch is
 * unreachable in practice, which is exactly why it needs a test rather than trust.
 */
export type DistPreconditionMode = 'run' | 'fail' | 'skip';

export function distPreconditionMode(facts: {
  distExists: boolean;
  ci: boolean;
}): DistPreconditionMode {
  if (facts.distExists) return 'run';
  return facts.ci ? 'fail' : 'skip';
}

/** The message a spec fails with when CI reaches it without a build. */
export function missingDistMessage(what: string): string {
  return [
    `${what} does not exist, so this spec cannot check anything.`,
    'These are the only checks that look at what `node ace configure` hands a user; under CI a',
    'missing build is a failure, not a skip. Run `pnpm build` before `pnpm test`, or restore',
    '`tasks.test.dependsOn: ["build", "^build"]` in turbo.json.',
  ].join(' ');
}

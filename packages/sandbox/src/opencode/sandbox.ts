import { Sandbox as BaseSandbox } from '../sandbox';
import { reEnsureOpenCodeHandles } from './lifecycle';

/**
 * OpenCode-aware {@link BaseSandbox}. Subclass this instead of the core
 * `Sandbox` when attaching an OpenCode lifecycle handle:
 *
 * ```ts
 * import { Sandbox, withOpenCode } from '@cloudflare/sandbox/opencode';
 *
 * class MySandbox extends Sandbox {
 *   opencode = withOpenCode(this);
 * }
 * ```
 *
 * The only behavior it adds over the core `Sandbox` is re-ensuring registered
 * OpenCode handles in `onStart`, so the `opencode serve` process is restored
 * after a container sleep or rollout without waiting for the next request.
 */
export class Sandbox<Env = unknown> extends BaseSandbox<Env> {
  override async onStart(): Promise<void> {
    await super.onStart();
    await reEnsureOpenCodeHandles(this as unknown as BaseSandbox<unknown>);
  }
}

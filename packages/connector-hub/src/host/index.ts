import type { Context } from '@deepseek-ai/cordis'

export const name = 'connector-hub'

/**
 * Host plugin entry. Business services are connected in later M1/M2 steps.
 * The rc.5 Cordis Context type is the boundary used by the real DSH runtime.
 */
export function apply(ctx: Context): void {
  void ctx
}

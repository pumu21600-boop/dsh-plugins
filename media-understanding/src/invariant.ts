/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-media-understanding`.
 * @module @deepseek-ai/dsh-media-understanding/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-media-understanding'

/** Cordis companion plugin name. */
export const name = 'media-understanding-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no mutable state of its own — the
 * settings seam owns the routes and the session log owns every understanding
 * outcome, both already covered by their owning packages' invariants.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

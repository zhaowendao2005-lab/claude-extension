// Host state is UI-only. Authoritative runs live in .budget/state.sqlite3.
// Domain types are exported by core/state.ts, not host PluginState.
export type ModelSearchQuery = string

declare module 'claude-code' {
  interface PluginState {
    'orcheatractor-zhaowendao': {
      query: string
    }
  }
}

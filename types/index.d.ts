export type Mode = 'on' | 'off'

export type Effort = 'low' | 'medium' | 'high'

/** The options in plugin.json's userConfig, parsed and clamped, defaults filled in. */
export type Config = {
  enabled: boolean
  model: string
  /** Models a call may name; always includes `model`. */
  models: string[]
  effort: Effort
  concurrency: number
  maxItems: number
  maxItemChars: number
  maxInstructionChars: number
  maxTokens: number
  timeoutMs: number
  inlineResultChars: number
  alwaysLoaded: boolean
}

/** The four token counts, as ModelUsage spells them. */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /fanout on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
  /** Tool calls that ran (refused calls are not counted). */
  calls: number
  items: number
  ok: number
  failed: number
  /** Items that needed a second attempt. */
  retried: number
  /** Requests made, retries included. */
  requests: number
  usage: Usage
}

declare module 'claude-code' {
  interface PluginState {
    'fanout': { session: Shaped<Session> }
  }
}

/**
 * Three rules fixed since the v0.5.5 stub so later versions cannot quietly
 * break them: AI is **optional** (the app is fully usable with no
 * provider), **model-agnostic** (local WebGPU/WASM, BYO-key, or self-hosted
 * all satisfy this), and it reaches the app only by emitting the same kind
 * of action a button or MIDI would — it never touches the audio graph or
 * the store directly.
 *
 * Two shapes live here on purpose, for two different scenarios (see
 * `docs/architecture/directions.md` §4's scenario table):
 * - `suggest()`/`AISuggestion` — a flat, ranked, one-shot list of
 *   passive suggestions. Reserved for v0.9.24 (coaching) and v0.13.5
 *   (live co-pilot) — not used by v0.5.5.
 * - `chat()`/tool-calling — a conversational exchange that can ask for
 *   clarification instead of guessing. What v0.5.5's NL translate layer
 *   actually needs, since "unclear command -> ask, don't guess" has no
 *   slot in a flat suggestion list.
 */
import type { ControlAction } from '@/core/mapping/mapping'

export interface AISuggestion {
  action: ControlAction
  value: number
  /** why, in one line — shown to the user before anything is applied */
  reason: string
  confidence: number
}

/** The handful of JSON-schema keys the local tool-calling catalog actually uses — not a general-purpose schema type. */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'boolean'
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: (string | number)[]
  description?: string
}

export type AIRole = 'user' | 'assistant' | 'tool'

export interface AIMessage {
  role: AIRole
  content: string
}

export interface AIToolDef {
  name: string
  description: string
  parameters: JsonSchema
}

export interface AIToolCall {
  name: string
  args: unknown
}

export type AIChatChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'toolCall'; call: AIToolCall }
  | { kind: 'done' }

export interface AIProvider {
  readonly id: string
  readonly kind: 'local' | 'byo-key' | 'self-hosted'
  readonly available: boolean
  readonly capabilities: ('chat' | 'embed-audio')[]
  suggest(prompt: string, context: unknown): Promise<AISuggestion[]>
  chat(msgs: AIMessage[], tools?: AIToolDef[]): AsyncIterable<AIChatChunk>
  /**
   * Only providers that need a one-time download/init before they can chat
   * implement this (a local model). BYO-key/self-hosted providers have
   * nothing to load and simply omit it.
   */
  load?(onProgress: (pct: number) => void): Promise<void>
}

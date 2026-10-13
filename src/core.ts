// Pure logic for opencode-followups: config, prompt building, parsing and the
// loop guard. Nothing here touches OpenCode, so it is unit-tested directly.
//
// The feature and the JSON contract ({"follow_ups": [...]}, first "{" to last
// "}") follow Open WebUI's follow-up generation task
// (https://github.com/open-webui/open-webui). The prompt text below is our own.

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface Config {
  /** Turn the plugin off without uninstalling it. */
  readonly enabled: boolean
  /** "provider/model" or "provider/model#variant". Empty = the prompt's selected model. */
  readonly model?: string
  /**
   * Variant used when `model` has none, e.g. a variant that turns thinking off.
   * Applied only when the model lists it. Empty string = never pick one.
   */
  readonly variant: string
  /** How many recent user/assistant messages go into the request. */
  readonly messages: number
  /** Characters kept per message (the tail of long ones is dropped). */
  readonly maxCharsPerMessage: number
  /** Abort the suggestion call after this many milliseconds. */
  readonly timeoutMs: number
  /** Number of suggestions to keep (1-5). */
  readonly count: number
  /** Characters kept per suggestion. */
  readonly maxSuggestionChars: number
  /** How long the toast stays up. */
  readonly toastMs: number
  /** Put the top suggestion into the prompt when it is focused and empty. */
  readonly insert: boolean
}

export const DEFAULTS: Config = {
  enabled: true,
  variant: "fast",
  messages: 6,
  maxCharsPerMessage: 1500,
  timeoutMs: 20_000,
  count: 5,
  maxSuggestionChars: 160,
  toastMs: 12_000,
  insert: true,
}

const int = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const bool = (value: unknown, fallback: boolean) => {
  if (typeof value === "boolean") return value
  if (value === "0" || value === "false" || value === "off") return false
  if (value === "1" || value === "true" || value === "on") return true
  return fallback
}

/**
 * Merges plugin options with environment overrides. Env wins so a user can
 * switch the feature off for one run: OPENCODE_FOLLOWUPS=0 opencode
 */
export function resolveConfig(
  options: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string | undefined>> = {},
): Config {
  const o = { ...options }
  if (env.OPENCODE_FOLLOWUPS !== undefined) o.enabled = env.OPENCODE_FOLLOWUPS
  if (env.OPENCODE_FOLLOWUPS_MODEL) o.model = env.OPENCODE_FOLLOWUPS_MODEL
  if (env.OPENCODE_FOLLOWUPS_TIMEOUT_MS) o.timeoutMs = env.OPENCODE_FOLLOWUPS_TIMEOUT_MS
  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim() : undefined
  return {
    enabled: bool(o.enabled, DEFAULTS.enabled),
    model: model && parseModelRef(model) ? model : undefined,
    variant: typeof o.variant === "string" ? o.variant.trim() : DEFAULTS.variant,
    messages: int(o.messages, 1, 40, DEFAULTS.messages),
    maxCharsPerMessage: int(o.maxCharsPerMessage, 200, 20_000, DEFAULTS.maxCharsPerMessage),
    timeoutMs: int(o.timeoutMs, 500, 120_000, DEFAULTS.timeoutMs),
    count: int(o.count, 1, 5, DEFAULTS.count),
    maxSuggestionChars: int(o.maxSuggestionChars, 20, 1_000, DEFAULTS.maxSuggestionChars),
    toastMs: int(o.toastMs, 1_000, 120_000, DEFAULTS.toastMs),
    insert: bool(o.insert, DEFAULTS.insert),
  }
}

/** Parses "provider/model" or "provider/model#variant" (OpenCode's own format). */
export function parseModelRef(value: string): ModelRef | undefined {
  const match = /^([^/#]+)\/([^#]+)(?:#([^#]+))?$/u.exec(value.trim())
  if (!match) return undefined
  return { providerID: match[1]!, id: match[2]!, ...(match[3] ? { variant: match[3] } : {}) }
}

/**
 * Picks the model for the suggestion call: the configured one, else the
 * prompt's current model. A variant is added only when the model offers it.
 */
export function chooseModel(
  config: Config,
  current: { providerID: string; modelID: string } | undefined,
  variants: readonly string[],
): ModelRef | undefined {
  if (config.model) return parseModelRef(config.model)
  if (!current) return undefined
  const ref: ModelRef = { providerID: current.providerID, id: current.modelID }
  return config.variant && variants.includes(config.variant) ? { ...ref, variant: config.variant } : ref
}

export interface Turn {
  readonly role: "user" | "assistant"
  readonly text: string
}

/**
 * Turns OpenCode v2 session messages into plain user/assistant turns. Tool
 * calls, reasoning, files and bookkeeping messages are dropped.
 */
export function toTurns(messages: readonly unknown[]): Turn[] {
  const turns: Turn[] = []
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue
    const message = raw as { type?: unknown; text?: unknown; content?: unknown }
    if (message.type === "user" && typeof message.text === "string") {
      if (message.text.trim()) turns.push({ role: "user", text: message.text.trim() })
      continue
    }
    if (message.type === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim()
      if (text) turns.push({ role: "assistant", text })
    }
  }
  return turns
}

const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…")

export function buildPrompt(turns: readonly Turn[], config: Pick<Config, "messages" | "maxCharsPerMessage" | "count">) {
  const history = turns
    .slice(-config.messages)
    .map((turn) => `${turn.role.toUpperCase()}: ${clip(turn.text, config.maxCharsPerMessage)}`)
    .join("\n\n")
  const n = config.count
  return [
    `You suggest what the USER could type next in a chat with an AI coding assistant.`,
    `Read the conversation below and write ${n === 1 ? "1 suggestion" : `up to ${n} suggestions`}.`,
    `Rules:`,
    `- Write each one as the user talking to the assistant, e.g. "Add tests for the parser".`,
    `- One short sentence each, under 20 words, specific to this conversation.`,
    `- Make each one a different next step (e.g. go deeper, test, refactor, explain, move on).`,
    `- Do not repeat anything that was already asked or done.`,
    `- Never suggest destructive actions (deleting files or history, force-pushing, dropping data).`,
    `- Use the language of the conversation.`,
    `- Reply with JSON only, no prose and no code fence: {"follow_ups": ["...", "..."]}`,
    ``,
    `<conversation>`,
    history,
    `</conversation>`,
  ].join("\n")
}

/**
 * Extracts suggestions from a model reply. Never throws: anything malformed
 * yields []. Mirrors Open WebUI: substring from the first "{" to the last "}".
 */
export function parseFollowUps(reply: unknown, config: Pick<Config, "count" | "maxSuggestionChars"> = DEFAULTS): string[] {
  if (typeof reply !== "string") return []
  // Drop a leaked <think> block so braces inside it can't confuse the slice.
  const text = reply.replace(/<think>[\s\S]*?<\/think>/giu, "")
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const list = value && typeof value === "object" ? (value as Record<string, unknown>).follow_ups : undefined
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== "string") continue
    const clean = clip(item.replace(/\s+/gu, " ").trim(), config.maxSuggestionChars)
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= config.count) break
  }
  return out
}

/** The parts of OpenTUI's textarea that composer insertion relies on. */
export interface Composer {
  readonly plainText: string
  readonly focused: boolean
  readonly isDestroyed: boolean
  insertText(text: string): void
}

/**
 * Inserts text into the prompt composer without clobbering anything: only when
 * the focused element is an empty, live textarea and no dialog or other input
 * mode is active. OpenCode v2 has no prompt-append API, so this duck-types
 * OpenTUI's focused renderable. Returns false when it did nothing.
 */
export function insertIntoComposer(focused: unknown, mode: string, text: string): boolean {
  if (!text || mode !== "base" || !focused || typeof focused !== "object") return false
  const editor = focused as Partial<Composer>
  if (typeof editor.insertText !== "function" || typeof editor.plainText !== "string") return false
  if (editor.isDestroyed || editor.focused === false || editor.plainText.length > 0) return false
  try {
    editor.insertText(text)
    return true
  } catch {
    return false
  }
}

export function formatToast(suggestions: readonly string[]) {
  return suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n\n/followup [n] to use one"
}

/**
 * Decides which turn ends get a suggestion call and whether a finished call is
 * still wanted. Each session has a turn counter; a result is only shown if no
 * newer turn started while it was generating.
 */
export class Guard {
  private turn = new Map<string, number>()
  private inflight = new Set<string>()

  /** A new turn started in this session (user sent a prompt). */
  started(sessionID: string) {
    this.turn.set(sessionID, (this.turn.get(sessionID) ?? 0) + 1)
  }

  /**
   * Returns a ticket when a suggestion call should run for this finished turn,
   * else undefined. Child (subagent) sessions and sessions that already have a
   * call running are skipped.
   */
  begin(sessionID: string, info: { parentID?: string | null } | undefined): number | undefined {
    if (!sessionID) return undefined
    if (info?.parentID) return undefined
    if (this.inflight.has(sessionID)) return undefined
    this.inflight.add(sessionID)
    return this.turn.get(sessionID) ?? 0
  }

  /** Ends the call; true when its result is still current and may be shown. */
  end(sessionID: string, ticket: number) {
    this.inflight.delete(sessionID)
    return (this.turn.get(sessionID) ?? 0) === ticket
  }

  forget(sessionID: string) {
    this.turn.delete(sessionID)
    this.inflight.delete(sessionID)
  }
}

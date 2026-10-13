import { describe, expect, test } from "bun:test"
import {
  buildPrompt,
  chooseModel,
  DEFAULTS,
  formatToast,
  Guard,
  insertIntoComposer,
  parseFollowUps,
  parseModelRef,
  resolveConfig,
  toTurns,
} from "../src/core.ts"

describe("parseFollowUps", () => {
  test("plain JSON", () => {
    expect(parseFollowUps('{"follow_ups": ["Add tests", "Explain the guard"]}')).toEqual([
      "Add tests",
      "Explain the guard",
    ])
  })

  test("prose and code fence around the JSON", () => {
    const reply = 'Sure!\n```json\n{"follow_ups": ["One?", "Two?"]}\n```\nHope that helps.'
    expect(parseFollowUps(reply)).toEqual(["One?", "Two?"])
  })

  test("leaked think block with braces is ignored", () => {
    const reply = '<think>maybe {"follow_ups": ["wrong"]} ...</think>{"follow_ups": ["right"]}'
    expect(parseFollowUps(reply)).toEqual(["right"])
  })

  test("malformed input never throws", () => {
    for (const bad of [
      "",
      "no json here",
      "{not json}",
      '{"follow_ups": "a string"}',
      '{"other": []}',
      "}{",
      "null",
      undefined,
      null,
      42,
      { follow_ups: ["object, not string"] },
    ]) {
      expect(parseFollowUps(bad as unknown)).toEqual([])
    }
  })

  test("drops non-strings, blanks and duplicates, collapses whitespace", () => {
    const reply = JSON.stringify({ follow_ups: ["A  b\n c", 3, "", "  ", "a b c", null, "Next"] })
    expect(parseFollowUps(reply)).toEqual(["A b c", "Next"])
  })

  test("caps count and length", () => {
    const reply = JSON.stringify({ follow_ups: ["1", "2", "3", "4", "5", "6", "7"] })
    expect(parseFollowUps(reply)).toHaveLength(5)
    expect(parseFollowUps(reply, { count: 3, maxSuggestionChars: 160 })).toEqual(["1", "2", "3"])
    const long = parseFollowUps(JSON.stringify({ follow_ups: ["x".repeat(500)] }), { count: 5, maxSuggestionChars: 50 })
    expect(long[0]).toHaveLength(50)
    expect(long[0]!.endsWith("…")).toBe(true)
  })
})

describe("Guard (loop and staleness)", () => {
  test("skips subagent sessions", () => {
    const guard = new Guard()
    expect(guard.begin("child", { parentID: "root" })).toBeUndefined()
  })

  test("one call per session at a time", () => {
    const guard = new Guard()
    const ticket = guard.begin("s", {})
    expect(ticket).toBeDefined()
    expect(guard.begin("s", {})).toBeUndefined()
    expect(guard.begin("other", {})).toBeDefined()
    expect(guard.end("s", ticket!)).toBe(true)
    expect(guard.begin("s", {})).toBeDefined()
  })

  test("result is dropped when a new turn started meanwhile", () => {
    const guard = new Guard()
    guard.started("s")
    const ticket = guard.begin("s", undefined)!
    guard.started("s")
    expect(guard.end("s", ticket)).toBe(false)
  })

  test("result is kept when no new turn started", () => {
    const guard = new Guard()
    guard.started("s")
    const ticket = guard.begin("s", { parentID: null })!
    expect(guard.end("s", ticket)).toBe(true)
  })

  test("empty session id is ignored", () => {
    expect(new Guard().begin("", {})).toBeUndefined()
  })
})

describe("resolveConfig", () => {
  test("defaults", () => {
    expect(resolveConfig()).toEqual(DEFAULTS)
  })

  test("clamps numbers and ignores junk", () => {
    const c = resolveConfig({ messages: 999, timeoutMs: 1, count: "3", toastMs: "abc", maxCharsPerMessage: -5 })
    expect(c.messages).toBe(40)
    expect(c.timeoutMs).toBe(500)
    expect(c.count).toBe(3)
    expect(c.toastMs).toBe(DEFAULTS.toastMs)
    expect(c.maxCharsPerMessage).toBe(200)
  })

  test("disable via option or env", () => {
    expect(resolveConfig({ enabled: false }).enabled).toBe(false)
    expect(resolveConfig({}, { OPENCODE_FOLLOWUPS: "0" }).enabled).toBe(false)
    expect(resolveConfig({ enabled: false }, { OPENCODE_FOLLOWUPS: "1" }).enabled).toBe(true)
  })

  test("model from option or env, invalid dropped", () => {
    expect(resolveConfig({ model: "local/qwen3#fast" }).model).toBe("local/qwen3#fast")
    expect(resolveConfig({ model: "nope" }).model).toBeUndefined()
    expect(resolveConfig({}, { OPENCODE_FOLLOWUPS_MODEL: "a/b" }).model).toBe("a/b")
  })
})

describe("models", () => {
  test("parseModelRef", () => {
    expect(parseModelRef("local/qwen3")).toEqual({ providerID: "local", id: "qwen3" })
    expect(parseModelRef("local/qwen3#fast")).toEqual({ providerID: "local", id: "qwen3", variant: "fast" })
    expect(parseModelRef("openrouter/org/model")).toEqual({ providerID: "openrouter", id: "org/model" })
    expect(parseModelRef("bad")).toBeUndefined()
  })

  test("chooseModel uses configured model first", () => {
    const c = resolveConfig({ model: "x/y#z" })
    expect(chooseModel(c, { providerID: "a", modelID: "b" }, ["fast"])).toEqual({ providerID: "x", id: "y", variant: "z" })
  })

  test("chooseModel adds the no-thinking variant only when offered", () => {
    const c = resolveConfig()
    const current = { providerID: "local", modelID: "qwen3" }
    expect(chooseModel(c, current, ["fast"])).toEqual({ providerID: "local", id: "qwen3", variant: "fast" })
    expect(chooseModel(c, current, [])).toEqual({ providerID: "local", id: "qwen3" })
    expect(chooseModel(resolveConfig({ variant: "" }), current, ["fast"])).toEqual({
      providerID: "local",
      id: "qwen3",
    })
    expect(chooseModel(c, undefined, [])).toBeUndefined()
  })
})

describe("prompt building", () => {
  const messages = [
    { type: "agent-selected", agent: "build" },
    { type: "user", id: "1", text: "Write a parser" },
    {
      type: "assistant",
      id: "2",
      content: [
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "Here is the parser." },
        { type: "tool", name: "write" },
      ],
    },
    { type: "idle", outcome: "succeeded" },
    { type: "user", id: "3", text: "   " },
  ]

  test("toTurns keeps only user/assistant text", () => {
    expect(toTurns(messages)).toEqual([
      { role: "user", text: "Write a parser" },
      { role: "assistant", text: "Here is the parser." },
    ])
    expect(toTurns([null, 1, "x", {}])).toEqual([])
  })

  test("buildPrompt keeps the last N turns and clips long ones", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, text: `msg${i} ` + "y".repeat(400) }))
    const prompt = buildPrompt(turns, { messages: 3, maxCharsPerMessage: 200, count: 4 })
    expect(prompt).not.toContain("msg6")
    expect(prompt).toContain("msg7")
    expect(prompt).toContain("msg9")
    expect(prompt).toContain("up to 4 suggestions")
    expect(prompt).toContain('{"follow_ups"')
    expect(prompt).not.toContain("y".repeat(250))
  })

  test("formatToast numbers suggestions", () => {
    expect(formatToast(["a", "b"])).toBe("1. a\n2. b\n\n/followup [n] to use one")
  })
})

describe("insertIntoComposer", () => {
  const editor = (plainText = "", extra: Record<string, unknown> = {}) => {
    const calls: string[] = []
    return { calls, plainText, focused: true, isDestroyed: false, insertText: (t: string) => void calls.push(t), ...extra }
  }

  test("inserts into an empty focused composer", () => {
    const e = editor()
    expect(insertIntoComposer(e, "base", "Add tests")).toBe(true)
    expect(e.calls).toEqual(["Add tests"])
  })

  test("never clobbers typed text", () => {
    const e = editor("half-typed")
    expect(insertIntoComposer(e, "base", "x")).toBe(false)
    expect(e.calls).toEqual([])
  })

  test("skips dialogs, other modes and non-editors", () => {
    expect(insertIntoComposer(editor(), "modal", "x")).toBe(false)
    expect(insertIntoComposer(editor("", { focused: false }), "base", "x")).toBe(false)
    expect(insertIntoComposer(editor("", { isDestroyed: true }), "base", "x")).toBe(false)
    expect(insertIntoComposer({ plainText: "" }, "base", "x")).toBe(false)
    expect(insertIntoComposer(null, "base", "x")).toBe(false)
    expect(insertIntoComposer(editor(), "base", "")).toBe(false)
  })

  test("a throwing editor is reported as not inserted", () => {
    const e = editor("", { insertText: () => { throw new Error("boom") } })
    expect(insertIntoComposer(e, "base", "x")).toBe(false)
  })
})

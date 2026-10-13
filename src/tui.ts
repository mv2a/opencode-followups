// OpenCode v2 TUI plugin: after every finished turn in a root session, ask the
// model for 3-5 prompts the user might send next, show them in a toast and put
// the top one in the (empty) prompt. `/followup [n]` swaps in another one.
// Nothing is ever sent: the user submits, edits or clears it.
//
// Why a TUI plugin: in OpenCode v2 only TUI plugins can show toasts. Server
// plugins have no toast or prompt API, and the `tui.prompt.append` event is
// never published by the server. Prompt insertion uses the focused OpenTUI
// textarea (see insertIntoComposer), since there is no public prompt API.
import type { Plugin } from "@opencode/plugin/tui"

type Context = Plugin.Context
type Definition = Plugin.Definition
import {
  buildPrompt,
  chooseModel,
  formatToast,
  Guard,
  insertIntoComposer,
  parseFollowUps,
  resolveConfig,
  toTurns,
} from "./core.ts"

const debug = () => process.env.OPENCODE_FOLLOWUPS_DEBUG === "1"

const plugin: Definition = {
  id: "opencode-followups",
  setup(context: Context) {
    const config = resolveConfig(context.options, process.env)
    if (!config.enabled) return

    const guard = new Guard()
    const latest = new Map<string, string[]>()
    const controllers = new Set<AbortController>()

    const generate = async (sessionID: string) => {
      const ticket = guard.begin(sessionID, context.data.session.get(sessionID))
      if (ticket === undefined) return
      const controller = new AbortController()
      controllers.add(controller)
      const timer = setTimeout(() => controller.abort(), config.timeoutMs)
      const started = performance.now()
      let suggestions: string[] = []
      try {
        const model = chooseModel(config, context.ui.model.current(), context.ui.model.variant.list())
        const messages = await context.client.session.context({ sessionID }, { signal: controller.signal })
        const turns = toTurns(messages)
        if (!turns.some((turn) => turn.role === "assistant")) return
        const result = await context.client.generate.text(
          { prompt: buildPrompt(turns, config), ...(model ? { model } : {}) },
          { signal: controller.signal },
        )
        suggestions = parseFollowUps((result as { text?: unknown })?.text, config)
      } catch (cause) {
        // Timeouts, network errors and bad replies are all silent by design.
        if (debug())
          context.ui.toast.show({ title: "Follow-ups failed", message: String(cause), variant: "warning", sessionID })
      } finally {
        clearTimeout(timer)
        controllers.delete(controller)
        const current = guard.end(sessionID, ticket)
        if (current && suggestions.length > 0) {
          latest.set(sessionID, suggestions)
          const seconds = ((performance.now() - started) / 1000).toFixed(1)
          context.ui.toast.show({
            title: `Follow-ups (${seconds}s)`,
            message: formatToast(suggestions),
            variant: "info",
            duration: config.toastMs,
            sessionID,
          })
          const route = context.ui.router.current() as { type: string; sessionID?: string }
          if (config.insert && route.type === "session" && route.sessionID === sessionID) insert(suggestions[0]!)
        }
      }
    }

    const insert = (text: string) =>
      insertIntoComposer(context.renderer.currentFocusedRenderable, context.keymap.mode.current(), text)

    const offs = [
      context.data.on("session.execution.started", (event) => {
        guard.started(event.data.sessionID)
        latest.delete(event.data.sessionID)
      }),
      context.data.on("session.execution.succeeded", (event) => {
        void generate(event.data.sessionID).catch(() => {})
      }),
      context.data.on("session.deleted", (event) => {
        const id = (event.data as { sessionID?: string }).sessionID
        if (id) {
          guard.forget(id)
          latest.delete(id)
        }
      }),
    ]

    const pick = async (input?: string) => {
      const route = context.ui.router.current() as { type: string; sessionID?: string }
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const suggestions = sessionID ? latest.get(sessionID) : undefined
      if (!sessionID || !suggestions?.length) {
        context.ui.toast.show({ message: "No follow-up suggestions for this session yet", variant: "warning" })
        return
      }
      const index = Number.parseInt(input?.trim() ?? "", 10)
      const chosen =
        Number.isInteger(index) && index >= 1 && index <= suggestions.length
          ? suggestions[index - 1]
          : await context.ui.dialog.select({
              title: "Follow-ups",
              options: suggestions.map((s, i) => ({ title: `${i + 1}. ${s}`, value: s })),
            })
      if (!chosen) return
      // Prefer the real prompt; wait a tick so focus returns there after the
      // select dialog or slash command closes.
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (insert(chosen)) return
      // Prompt not empty or not focused: fall back to an editable dialog. The
      // user still decides what, if anything, is sent.
      const text = await context.ui.dialog.prompt({
        title: "Send follow-up",
        description: "Edit if needed. Enter sends, Esc cancels.",
        value: chosen,
      })
      if (!text?.trim()) return
      await context.client.session.prompt({ sessionID, text: text.trim() }).catch((cause: unknown) => {
        context.ui.toast.show({ title: "Follow-up not sent", message: String(cause), variant: "error" })
      })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "followups.pick",
          title: "Use a follow-up suggestion",
          description: "Put one of the suggested next prompts in the prompt",
          group: "Session",
          palette: true,
          slash: { name: "followup", aliases: ["fu"], arguments: true },
          run: (input) => pick(input),
        },
      ],
    }))

    return () => {
      for (const off of offs) off()
      for (const controller of controllers) controller.abort()
    }
  },
}

export default plugin

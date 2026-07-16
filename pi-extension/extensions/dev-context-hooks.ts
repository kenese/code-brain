/**
 * dev-context hooks for pi
 *
 * Pi has no built-in hooks system (unlike Claude Code / Codex / Gemini), so this
 * extension replicates the dev-context lifecycle wiring using pi's extension
 * events, reusing the harness-agnostic shell scripts bundled alongside this
 * file (copied from the repo's top-level `hooks/`):
 *
 *   - session_start    -> dev-context-connect.sh              (auto-connect instruction)
 *   - tool_call         -> dev-context-watchdog.sh              (staleness reminder)
 *   - agent_settled     -> dev-context-checkpoint.sh             (checkpoint nudge)
 *   - session_shutdown  -> dev-context-checkpoint.sh --background (safety net)
 *
 * Note: pi's MCP adapter (pi-mcp-adapter) exposes MCP tools with a
 * "<server>_" prefix, e.g. dev_context_connect rather than Claude Code's bare
 * "connect". The connect message below tells the model the correct tool name
 * for this harness.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SCRIPTS_DIR = process.env.DEV_CONTEXT_HOOKS_DIR?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

const CONNECT_SCRIPT = join(SCRIPTS_DIR, "dev-context-connect.sh");
const WATCHDOG_SCRIPT = join(SCRIPTS_DIR, "dev-context-watchdog.sh");
const CHECKPOINT_SCRIPT = join(SCRIPTS_DIR, "dev-context-checkpoint.sh");

const WATCHDOG_TOOLS = new Set(["edit", "write", "bash"]);

export default function (pi: ExtensionAPI) {
  // --- auto-connect on session start ---
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new" && event.reason !== "resume") return;

    const result = await pi.exec("bash", [CONNECT_SCRIPT], { cwd: ctx.cwd, timeout: 10_000 });
    const text = result.stdout.trim();
    if (!text) return;

    const piNote =
      "Note: on this harness, call it as dev_context_connect (dev-context MCP tools are prefixed dev_context_*).";

    pi.sendMessage(
      {
        customType: "dev-context-connect",
        content: `${text}\n${piNote}`,
        display: false,
      },
      { deliverAs: "nextTurn" },
    );
  });

  // --- staleness watchdog after edits/bash ---
  pi.on("tool_call", async (event, ctx) => {
    if (!WATCHDOG_TOOLS.has(event.toolName)) return;

    const result = await pi.exec("bash", [WATCHDOG_SCRIPT], { cwd: ctx.cwd, timeout: 5_000 });
    const text = result.stdout.trim();
    if (!text) return;

    pi.sendMessage(
      {
        customType: "dev-context-watchdog",
        content: text,
        display: false,
      },
      { deliverAs: "steer" },
    );
  });

  // --- checkpoint nudge when the agent settles ---
  pi.on("agent_settled", async (_event, ctx) => {
    const result = await pi.exec("bash", [CHECKPOINT_SCRIPT], { cwd: ctx.cwd, timeout: 5_000 });
    const text = result.stdout.trim();
    if (!text) return;

    pi.sendMessage(
      {
        customType: "dev-context-checkpoint",
        content: text,
        display: false,
      },
      { deliverAs: "nextTurn" },
    );
  });

  // --- background safety net on shutdown ---
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    // pi.exec() has no stdin option, so pipe the transcript path JSON in via
    // a subshell (the script reads its hook input as JSON on stdin).
    const payload = JSON.stringify({ transcript_path: sessionFile }).replace(/'/g, "'\\''");
    await pi.exec(
      "bash",
      ["-c", `printf '%s' '${payload}' | bash "${CHECKPOINT_SCRIPT}" --background`],
      { cwd: ctx.cwd, timeout: 30_000 },
    );
  });
}

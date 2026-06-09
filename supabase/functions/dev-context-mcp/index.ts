import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Types ---
type Plan = {
    id: string;
    repo_id: string;
    title: string;
    focus: string;
    branch: string | null;
    worktree_path: string | null;
    status: string;
    cursor_phase_id: string | null;
    cursor_step_id: string | null;
    position_note: string;
};

type Phase = {
    id: string;
    plan_id: string;
    title: string;
    status: string;
    order_index: number;
    rollup: string | null;
    completed_at: string | null;
};

type Step = {
    id: string;
    phase_id: string;
    title: string;
    detail: string;
    progress_note: string | null;
    status: string;
    order_index: number;
};

// --- Active session context (best-effort per warm instance) ---
// connect() sets this; cursor tools read it. Tools also accept explicit
// repo/plan overrides so a cold instance can still be driven by the agent,
// which received these ids in the connect() bundle.
let active: { repoId: string | null; planId: string | null } = {
    repoId: null,
    planId: null,
};

const WORKING_CONTRACT = `--- dev-context working contract ---
You are working under dev-context for this repo. Maintain the plan as you work, without being asked:
- When a task isn't represented in the plan, decompose it into steps and add_step them (surface what you added, don't wait for approval).
- As you complete meaningful work, call complete_step and keep position_note current via update_progress.
- When a phase is fully done, propose complete_phase to the user first (it archives + summarizes the phase).
- To work on a different repo or line of work, name it explicitly (connect / switch_plan).`;

// --- OpenRouter helpers (same pattern as open-brain-mcp) ---
async function getEmbedding(text: string): Promise<number[]> {
    const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "openai/text-embedding-3-small",
            input: text,
        }),
    });
    if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
    }
    const d = await r.json();
    return d.data[0].embedding;
}

async function extractKnowledgeMetadata(
    kind: string,
    title: string,
    body: string
): Promise<Record<string, unknown>> {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `Extract metadata from a saved coding knowledge item (kind: ${kind}). Return JSON with:
- "language": primary programming language/tool if any (empty string if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "tags": array of additional freeform tags (empty if none)
Only extract what's explicitly there.`,
                },
                { role: "user", content: `Title: ${title}\n\n${body}` },
            ],
        }),
    });
    const d = await r.json();
    try {
        return JSON.parse(d.choices[0].message.content);
    } catch {
        return { topics: ["uncategorized"], language: "", tags: [] };
    }
}

async function rollupPhase(
    phaseTitle: string,
    steps: Step[]
): Promise<{ text: string; embedding: number[] }> {
    const stepsText = steps
        .map(
            (s) =>
                `- ${s.title} [${s.status}]${s.progress_note ? `: ${s.progress_note}` : ""}`
        )
        .join("\n");
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `Summarize a completed work phase into a compact history entry. Return JSON with:
- "summary": one or two sentences on what was accomplished
- "decisions": array of key decisions or learnings worth remembering (empty if none)`,
                },
                {
                    role: "user",
                    content: `Phase: ${phaseTitle}\nSteps:\n${stepsText}`,
                },
            ],
        }),
    });
    let summary = phaseTitle;
    let decisions: string[] = [];
    try {
        const d = await r.json();
        const parsed = JSON.parse(d.choices[0].message.content);
        summary = parsed.summary || phaseTitle;
        decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    } catch {
        // Fall back to the phase title as the rollup if the LLM call fails.
    }
    const text =
        `${phaseTitle}: ${summary}` +
        (decisions.length ? `\nDecisions: ${decisions.join("; ")}` : "");
    const embedding = await getEmbedding(text);
    return { text, embedding };
}

// --- Data helpers ---
function ok(text: string) {
    return { content: [{ type: "text" as const, text }] };
}
function err(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true };
}

function requireActive(): { repoId: string; planId: string | null } {
    if (!active.repoId) {
        throw new Error("No active repo. Call connect(repo) first.");
    }
    return { repoId: active.repoId, planId: active.planId };
}

async function loadPlan(planId: string): Promise<Plan | null> {
    const { data } = await supabase.from("plans").select("*").eq("id", planId).single();
    return (data as Plan) || null;
}

async function renderActivePlan(plan: Plan): Promise<string> {
    const lines: string[] = [`### Active plan: ${plan.title}`];
    if (plan.focus) lines.push(`Focus: ${plan.focus}`);
    if (plan.branch) lines.push(`Branch: ${plan.branch}`);

    const { data: phases } = await supabase
        .from("phases")
        .select("*")
        .eq("plan_id", plan.id)
        .order("order_index", { ascending: true });

    const phaseList = (phases || []) as Phase[];
    lines.push("", "Phases:");
    for (const ph of phaseList) {
        const marker = ph.id === plan.cursor_phase_id ? "→" : " ";
        const label =
            ph.status === "done" && ph.rollup ? `done — ${ph.rollup.split("\n")[0]}` : ph.status;
        lines.push(`${marker} [${label}] ${ph.title}`);
    }

    // Current phase's steps (titles + status only)
    if (plan.cursor_phase_id) {
        const { data: steps } = await supabase
            .from("steps")
            .select("*")
            .eq("phase_id", plan.cursor_phase_id)
            .order("order_index", { ascending: true });
        const stepList = (steps || []) as Step[];
        if (stepList.length) {
            lines.push("", "Current phase steps:");
            for (const s of stepList) {
                const marker = s.id === plan.cursor_step_id ? "→" : " ";
                lines.push(`${marker} [${s.status}] ${s.title}`);
            }
            // Current step full detail + position note
            const cur = stepList.find((s) => s.id === plan.cursor_step_id);
            if (cur) {
                lines.push("", `Current step: ${cur.title}`);
                if (cur.detail) lines.push(cur.detail);
            }
        }
    }
    if (plan.position_note) lines.push("", `You are here: ${plan.position_note}`);
    return lines.join("\n");
}

// --- MCP Server Setup ---
const server = new McpServer({
    name: "dev-context",
    version: "1.0.0",
});

// connect — the one call that orients a session
server.registerTool(
    "connect",
    {
        title: "Connect to repo context",
        description:
            "Connect to a repo's dev-context at session start. Resolves the active plan from the current git branch/worktree and returns architecture, plan/idea titles, and the active plan's current slice. Call this first.",
        inputSchema: {
            repo: z.string().describe("Repo identifier, e.g. 'owner/name'"),
            branch: z.string().optional().describe("Current git branch"),
            worktree: z.string().optional().describe("Current worktree path"),
        },
    },
    async ({ repo, branch, worktree }) => {
        try {
            // Ensure the repo row exists
            await supabase.from("repos").upsert({ repo_id: repo }, { onConflict: "repo_id" });

            const { data: repoRow } = await supabase
                .from("repos")
                .select("architecture_doc")
                .eq("repo_id", repo)
                .single();

            const { data: plans } = await supabase
                .from("plans")
                .select("id, title, branch, status")
                .eq("repo_id", repo)
                .order("updated_at", { ascending: false });
            const planList = (plans || []) as Pick<Plan, "id" | "title" | "branch" | "status">[];

            const { data: ideas } = await supabase
                .from("ideas")
                .select("id, title")
                .eq("repo_id", repo)
                .order("created_at", { ascending: false });

            // Resolve active plan: branch match first, then worktree path.
            let activePlan: Plan | null = null;
            if (branch) {
                const m = planList.find((p) => p.branch === branch && p.status !== "done");
                if (m) activePlan = await loadPlan(m.id);
            }
            if (!activePlan && worktree) {
                const { data } = await supabase
                    .from("plans")
                    .select("*")
                    .eq("repo_id", repo)
                    .eq("worktree_path", worktree)
                    .neq("status", "done")
                    .limit(1);
                if (data && data.length) activePlan = data[0] as Plan;
            }

            active = { repoId: repo, planId: activePlan?.id || null };

            const out: string[] = [`# dev-context: ${repo}`];
            out.push(
                "",
                "## Architecture",
                repoRow?.architecture_doc?.trim() || "(none yet — use update_architecture to set it)"
            );

            out.push("", "## Plans");
            if (planList.length) {
                for (const p of planList) {
                    const marker = p.id === activePlan?.id ? "→" : " ";
                    out.push(
                        `${marker} ${p.title} [${p.status}${p.branch ? `, ${p.branch}` : ""}] (id: ${p.id})`
                    );
                }
            } else {
                out.push("(no plans yet — create_plan to start one)");
            }

            if (ideas && ideas.length) {
                out.push("", "## Ideas");
                for (const i of ideas) out.push(`- ${i.title} (id: ${i.id})`);
            }

            out.push("");
            if (activePlan) {
                out.push(await renderActivePlan(activePlan));
            } else if (branch) {
                out.push(
                    `No plan bound to branch "${branch}". Offer to create_plan(title, focus, branch="${branch}") if starting new work here.`
                );
            } else {
                out.push("No active plan resolved. Use switch_plan or create_plan.");
            }

            out.push("", WORKING_CONTRACT);
            return ok(out.join("\n"));
        } catch (e) {
            return err(`connect error: ${(e as Error).message}`);
        }
    }
);

// --- Tier 2 expansion ---
server.registerTool(
    "get_plan",
    {
        title: "Get plan detail",
        description: "Get full detail of a plan by id: its phases and their steps.",
        annotations: { readOnlyHint: true },
        inputSchema: { id: z.string() },
    },
    async ({ id }) => {
        try {
            const plan = await loadPlan(id);
            if (!plan) return err("Plan not found.");
            const { data: phases } = await supabase
                .from("phases")
                .select("*")
                .eq("plan_id", id)
                .order("order_index", { ascending: true });
            const lines = [`Plan: ${plan.title}`, `Focus: ${plan.focus}`, `Status: ${plan.status}`];
            for (const ph of (phases || []) as Phase[]) {
                lines.push("", `[${ph.status}] ${ph.title} (id: ${ph.id})`);
                if (ph.rollup) lines.push(`  rollup: ${ph.rollup}`);
                const { data: steps } = await supabase
                    .from("steps")
                    .select("title, status")
                    .eq("phase_id", ph.id)
                    .order("order_index", { ascending: true });
                for (const s of (steps || []) as Step[]) lines.push(`    [${s.status}] ${s.title}`);
            }
            return ok(lines.join("\n"));
        } catch (e) {
            return err(`get_plan error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "get_phase",
    {
        title: "Get phase detail",
        description: "Get full detail of a phase by id, including all its steps and notes.",
        annotations: { readOnlyHint: true },
        inputSchema: { id: z.string() },
    },
    async ({ id }) => {
        try {
            const { data: ph } = await supabase.from("phases").select("*").eq("id", id).single();
            if (!ph) return err("Phase not found.");
            const phase = ph as Phase;
            const { data: steps } = await supabase
                .from("steps")
                .select("*")
                .eq("phase_id", id)
                .order("order_index", { ascending: true });
            const lines = [`Phase: ${phase.title} [${phase.status}]`];
            if (phase.rollup) lines.push(`Rollup: ${phase.rollup}`);
            for (const s of (steps || []) as Step[]) {
                lines.push("", `[${s.status}] ${s.title} (id: ${s.id})`);
                if (s.detail) lines.push(s.detail);
                if (s.progress_note) lines.push(`  note: ${s.progress_note}`);
            }
            return ok(lines.join("\n"));
        } catch (e) {
            return err(`get_phase error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "get_step",
    {
        title: "Get step detail",
        description: "Get full detail of a single step by id.",
        annotations: { readOnlyHint: true },
        inputSchema: { id: z.string() },
    },
    async ({ id }) => {
        try {
            const { data } = await supabase.from("steps").select("*").eq("id", id).single();
            if (!data) return err("Step not found.");
            const s = data as Step;
            const lines = [`Step: ${s.title} [${s.status}]`];
            if (s.detail) lines.push(s.detail);
            if (s.progress_note) lines.push(`Note: ${s.progress_note}`);
            return ok(lines.join("\n"));
        } catch (e) {
            return err(`get_step error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "get_idea",
    {
        title: "Get idea detail",
        description: "Get the full body of a repo idea by id.",
        annotations: { readOnlyHint: true },
        inputSchema: { id: z.string() },
    },
    async ({ id }) => {
        try {
            const { data } = await supabase.from("ideas").select("*").eq("id", id).single();
            if (!data) return err("Idea not found.");
            return ok(`${data.title}\n\n${data.body || "(no detail)"}`);
        } catch (e) {
            return err(`get_idea error: ${(e as Error).message}`);
        }
    }
);

// --- Plans ---
server.registerTool(
    "create_plan",
    {
        title: "Create plan",
        description:
            "Create a new plan (line of work) in the active repo, optionally bound to a git branch. Becomes the active plan.",
        inputSchema: {
            title: z.string(),
            focus: z.string().optional(),
            branch: z.string().optional(),
            worktree: z.string().optional(),
        },
    },
    async ({ title, focus, branch, worktree }) => {
        try {
            const { repoId } = requireActive();
            const { data, error } = await supabase
                .from("plans")
                .insert({
                    repo_id: repoId,
                    title,
                    focus: focus || "",
                    branch: branch || null,
                    worktree_path: worktree || null,
                })
                .select("id")
                .single();
            if (error) return err(`create_plan error: ${error.message}`);
            active.planId = data.id;
            return ok(`Created plan "${title}" (id: ${data.id})${branch ? ` bound to ${branch}` : ""}. It is now active.`);
        } catch (e) {
            return err(`create_plan error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "switch_plan",
    {
        title: "Switch active plan",
        description: "Manually activate a different plan by id (when not relying on branch auto-resolution).",
        inputSchema: { id: z.string() },
    },
    async ({ id }) => {
        try {
            const plan = await loadPlan(id);
            if (!plan) return err("Plan not found.");
            active = { repoId: plan.repo_id, planId: plan.id };
            return ok(await renderActivePlan(plan));
        } catch (e) {
            return err(`switch_plan error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "update_focus",
    {
        title: "Update plan focus",
        description: "Update the active plan's one-line focus.",
        inputSchema: { text: z.string(), plan_id: z.string().optional() },
    },
    async ({ text, plan_id }) => {
        try {
            const { planId } = requireActive();
            const target = plan_id || planId;
            if (!target) return err("No active plan. Use switch_plan or create_plan.");
            await supabase.from("plans").update({ focus: text, updated_at: new Date().toISOString() }).eq("id", target);
            return ok(`Focus updated.`);
        } catch (e) {
            return err(`update_focus error: ${(e as Error).message}`);
        }
    }
);

// --- Cursor (cheap, frequent) ---
server.registerTool(
    "update_progress",
    {
        title: "Update progress note",
        description:
            "Write the active plan's 'you are here' position note. Optionally mark the current step in_progress. Call this to keep the plan anchored as you work.",
        inputSchema: {
            note: z.string(),
            mark_in_progress: z.boolean().optional().default(true),
        },
    },
    async ({ note, mark_in_progress }) => {
        try {
            const { planId } = requireActive();
            if (!planId) return err("No active plan.");
            const plan = await loadPlan(planId);
            if (!plan) return err("Active plan not found.");
            await supabase
                .from("plans")
                .update({ position_note: note, updated_at: new Date().toISOString() })
                .eq("id", planId);
            if (mark_in_progress && plan.cursor_step_id) {
                await supabase.from("steps").update({ status: "in_progress" }).eq("id", plan.cursor_step_id);
            }
            return ok("Progress noted.");
        } catch (e) {
            return err(`update_progress error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "complete_step",
    {
        title: "Complete current step",
        description:
            "Mark the active plan's current step done and advance the cursor to the next todo step in the phase. Call this as you finish meaningful units of work.",
        inputSchema: {
            note: z.string().optional().describe("Optional closing note for the step"),
        },
    },
    async ({ note }) => {
        try {
            const { planId } = requireActive();
            if (!planId) return err("No active plan.");
            const plan = await loadPlan(planId);
            if (!plan || !plan.cursor_step_id) return err("No current step to complete.");

            await supabase
                .from("steps")
                .update({ status: "done", ...(note ? { progress_note: note } : {}) })
                .eq("id", plan.cursor_step_id);

            // Find next todo step in the same phase
            const { data: steps } = await supabase
                .from("steps")
                .select("*")
                .eq("phase_id", plan.cursor_phase_id!)
                .order("order_index", { ascending: true });
            const next = ((steps || []) as Step[]).find((s) => s.status === "todo");

            if (next) {
                await supabase.from("steps").update({ status: "in_progress" }).eq("id", next.id);
                await supabase
                    .from("plans")
                    .update({ cursor_step_id: next.id, updated_at: new Date().toISOString() })
                    .eq("id", planId);
                return ok(`Step completed. Now on: ${next.title}`);
            } else {
                await supabase
                    .from("plans")
                    .update({ cursor_step_id: null, updated_at: new Date().toISOString() })
                    .eq("id", planId);
                return ok("Step completed. No more todo steps in this phase — consider complete_phase.");
            }
        } catch (e) {
            return err(`complete_step error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "complete_phase",
    {
        title: "Complete current phase",
        description:
            "Archive the active plan's current phase: summarize it into a rollup and advance to the next phase. SURFACE THIS TO THE USER FIRST — call with confirm=false to preview what will be archived, then confirm=true once the user agrees.",
        inputSchema: {
            confirm: z.boolean().optional().default(false),
        },
    },
    async ({ confirm }) => {
        try {
            const { planId } = requireActive();
            if (!planId) return err("No active plan.");
            const plan = await loadPlan(planId);
            if (!plan || !plan.cursor_phase_id) return err("No current phase.");

            const { data: phaseRow } = await supabase
                .from("phases")
                .select("*")
                .eq("id", plan.cursor_phase_id)
                .single();
            const phase = phaseRow as Phase;
            const { data: stepsData } = await supabase
                .from("steps")
                .select("*")
                .eq("phase_id", phase.id)
                .order("order_index", { ascending: true });
            const steps = (stepsData || []) as Step[];

            if (!confirm) {
                const open = steps.filter((s) => s.status !== "done");
                const lines = [
                    `About to archive phase "${phase.title}" (${steps.length} steps).`,
                    open.length ? `${open.length} step(s) not marked done: ${open.map((s) => s.title).join(", ")}` : "All steps done.",
                    "Confirm with the user, then call complete_phase(confirm=true).",
                ];
                return ok(lines.join("\n"));
            }

            const { text, embedding } = await rollupPhase(phase.title, steps);
            await supabase
                .from("phases")
                .update({
                    status: "done",
                    rollup: text,
                    rollup_embedding: embedding,
                    completed_at: new Date().toISOString(),
                })
                .eq("id", phase.id);

            // Advance to next upcoming phase
            const { data: nextPhases } = await supabase
                .from("phases")
                .select("*")
                .eq("plan_id", planId)
                .eq("status", "upcoming")
                .order("order_index", { ascending: true })
                .limit(1);
            const nextPhase = (nextPhases || [])[0] as Phase | undefined;

            if (nextPhase) {
                await supabase.from("phases").update({ status: "active" }).eq("id", nextPhase.id);
                const { data: firstSteps } = await supabase
                    .from("steps")
                    .select("*")
                    .eq("phase_id", nextPhase.id)
                    .order("order_index", { ascending: true })
                    .limit(1);
                const firstStep = (firstSteps || [])[0] as Step | undefined;
                if (firstStep) {
                    await supabase.from("steps").update({ status: "in_progress" }).eq("id", firstStep.id);
                }
                await supabase
                    .from("plans")
                    .update({
                        cursor_phase_id: nextPhase.id,
                        cursor_step_id: firstStep?.id || null,
                        position_note: "",
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", planId);
                return ok(`Phase "${phase.title}" archived.\nRollup: ${text}\n\nNow on phase: ${nextPhase.title}`);
            } else {
                await supabase
                    .from("plans")
                    .update({
                        cursor_phase_id: null,
                        cursor_step_id: null,
                        status: "done",
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", planId);
                return ok(`Phase "${phase.title}" archived.\nRollup: ${text}\n\nNo more phases — plan marked done.`);
            }
        } catch (e) {
            return err(`complete_phase error: ${(e as Error).message}`);
        }
    }
);

// --- Planning ---
server.registerTool(
    "add_phase",
    {
        title: "Add phase",
        description:
            "Add a phase to the active plan (or a given plan). If the plan has no active phase yet, the first added phase becomes active and sets the cursor.",
        inputSchema: {
            title: z.string(),
            plan_id: z.string().optional(),
            position: z.number().optional().describe("order_index; defaults to end"),
        },
    },
    async ({ title, plan_id, position }) => {
        try {
            const { planId } = requireActive();
            const target = plan_id || planId;
            if (!target) return err("No active plan.");

            const { data: existing } = await supabase
                .from("phases")
                .select("id, order_index")
                .eq("plan_id", target)
                .order("order_index", { ascending: false })
                .limit(1);
            const nextOrder = position ?? (((existing || [])[0]?.order_index ?? -1) + 1);
            const isFirst = !existing || existing.length === 0;

            const { data, error } = await supabase
                .from("phases")
                .insert({
                    plan_id: target,
                    title,
                    order_index: nextOrder,
                    status: isFirst ? "active" : "upcoming",
                })
                .select("id")
                .single();
            if (error) return err(`add_phase error: ${error.message}`);

            if (isFirst) {
                await supabase
                    .from("plans")
                    .update({ cursor_phase_id: data.id, updated_at: new Date().toISOString() })
                    .eq("id", target);
            }
            return ok(`Added phase "${title}" (id: ${data.id})${isFirst ? " — now the active phase." : "."}`);
        } catch (e) {
            return err(`add_phase error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "add_step",
    {
        title: "Add step",
        description:
            "Add a step to a phase. If the phase is the cursor phase and has no current step, this step becomes the cursor step.",
        inputSchema: {
            phase_id: z.string(),
            title: z.string(),
            detail: z.string().optional(),
        },
    },
    async ({ phase_id, title, detail }) => {
        try {
            const { data: existing } = await supabase
                .from("steps")
                .select("order_index")
                .eq("phase_id", phase_id)
                .order("order_index", { ascending: false })
                .limit(1);
            const nextOrder = ((existing || [])[0]?.order_index ?? -1) + 1;

            const { data, error } = await supabase
                .from("steps")
                .insert({ phase_id, title, detail: detail || "", order_index: nextOrder })
                .select("id")
                .single();
            if (error) return err(`add_step error: ${error.message}`);

            // If this phase is the active plan's cursor phase with no current step, adopt it.
            const { planId } = active;
            if (planId) {
                const plan = await loadPlan(planId);
                if (plan && plan.cursor_phase_id === phase_id && !plan.cursor_step_id) {
                    await supabase.from("steps").update({ status: "in_progress" }).eq("id", data.id);
                    await supabase.from("plans").update({ cursor_step_id: data.id }).eq("id", planId);
                }
            }
            return ok(`Added step "${title}" (id: ${data.id}).`);
        } catch (e) {
            return err(`add_step error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "update_architecture",
    {
        title: "Update architecture doc",
        description:
            "Replace the active repo's architecture doc (stable markdown injected at connect). Use sparingly — for real architectural changes.",
        inputSchema: { doc: z.string(), repo: z.string().optional() },
    },
    async ({ doc, repo }) => {
        try {
            const target = repo || active.repoId;
            if (!target) return err("No active repo.");
            await supabase
                .from("repos")
                .upsert(
                    { repo_id: target, architecture_doc: doc, updated_at: new Date().toISOString() },
                    { onConflict: "repo_id" }
                );
            return ok("Architecture doc updated.");
        } catch (e) {
            return err(`update_architecture error: ${(e as Error).message}`);
        }
    }
);

// --- Ideas ---
server.registerTool(
    "add_idea",
    {
        title: "Add idea",
        description: "Save a future-work idea / opportunity for the active repo.",
        inputSchema: { title: z.string(), body: z.string().optional() },
    },
    async ({ title, body }) => {
        try {
            const { repoId } = requireActive();
            const { data, error } = await supabase
                .from("ideas")
                .insert({ repo_id: repoId, title, body: body || null })
                .select("id")
                .single();
            if (error) return err(`add_idea error: ${error.message}`);
            return ok(`Idea saved (id: ${data.id}).`);
        } catch (e) {
            return err(`add_idea error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "list_ideas",
    {
        title: "List ideas",
        description: "List the active repo's future-work ideas.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
    },
    async () => {
        try {
            const { repoId } = requireActive();
            const { data } = await supabase
                .from("ideas")
                .select("id, title")
                .eq("repo_id", repoId)
                .order("created_at", { ascending: false });
            if (!data || !data.length) return ok("No ideas yet.");
            return ok(data.map((i) => `- ${i.title} (id: ${i.id})`).join("\n"));
        } catch (e) {
            return err(`list_ideas error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "promote_idea_to_plan",
    {
        title: "Promote idea to plan",
        description: "Turn a repo idea into a new active plan, optionally bound to a branch. Removes it from the idea pool.",
        inputSchema: {
            idea_id: z.string(),
            branch: z.string().optional(),
        },
    },
    async ({ idea_id, branch }) => {
        try {
            const { repoId } = requireActive();
            const { data: idea } = await supabase.from("ideas").select("*").eq("id", idea_id).single();
            if (!idea) return err("Idea not found.");
            const { data: plan, error } = await supabase
                .from("plans")
                .insert({
                    repo_id: repoId,
                    title: idea.title,
                    focus: idea.body || "",
                    branch: branch || null,
                })
                .select("id")
                .single();
            if (error) return err(`promote error: ${error.message}`);
            await supabase.from("ideas").delete().eq("id", idea_id);
            active.planId = plan.id;
            return ok(`Promoted idea to plan "${idea.title}" (id: ${plan.id}). Now active.`);
        } catch (e) {
            return err(`promote_idea_to_plan error: ${(e as Error).message}`);
        }
    }
);

// --- Knowledge (cross-repo, vector-searchable) ---
server.registerTool(
    "save_knowledge",
    {
        title: "Save knowledge",
        description:
            "Save a reusable knowledge item (script, decision, or skill). Extracts metadata and stores an embedding for later semantic recall. Scope 'repo' ties it to the active repo; 'global' makes it cross-repo.",
        inputSchema: {
            kind: z.enum(["script", "decision", "skill"]),
            title: z.string(),
            body: z.string(),
            scope: z.enum(["repo", "global"]).optional().default("repo"),
        },
    },
    async ({ kind, title, body, scope }) => {
        try {
            const repoId = scope === "global" ? null : requireActive().repoId;
            const [embedding, metadata] = await Promise.all([
                getEmbedding(`${title}\n\n${body}`),
                extractKnowledgeMetadata(kind, title, body),
            ]);
            const { data: newId, error } = await supabase.rpc("upsert_knowledge", {
                p_repo_id: repoId,
                p_kind: kind,
                p_title: title,
                p_body: body,
                p_metadata: metadata,
            });
            if (error) return err(`save_knowledge error: ${error.message}`);
            const { error: embErr } = await supabase
                .from("knowledge_items")
                .update({ embedding })
                .eq("id", newId);
            if (embErr) return err(`Failed to save embedding: ${embErr.message}`);
            return ok(`Saved ${kind} "${title}" (${scope}).`);
        } catch (e) {
            return err(`save_knowledge error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "search_knowledge",
    {
        title: "Search knowledge",
        description:
            "Semantic search over saved knowledge (scripts, decisions, skills). Scope 'repo' = this repo + global; 'global' = global only; 'all' = everything.",
        annotations: { readOnlyHint: true },
        inputSchema: {
            query: z.string(),
            kind: z.enum(["script", "decision", "skill"]).optional(),
            scope: z.enum(["repo", "global", "all"]).optional().default("repo"),
            limit: z.number().optional().default(10),
        },
    },
    async ({ query, kind, scope, limit }) => {
        try {
            const qEmb = await getEmbedding(query);
            const args: Record<string, unknown> = {
                query_embedding: qEmb,
                match_count: limit,
                match_threshold: 0.4,
                kind_filter: kind || null,
            };
            if (scope === "global") {
                args.only_global = true;
            } else if (scope === "repo") {
                args.repo_filter = active.repoId; // includes globals too (RPC ORs null)
            } // 'all' → no repo filter, not only_global

            const { data, error } = await supabase.rpc("match_knowledge", args);
            if (error) return err(`search_knowledge error: ${error.message}`);
            if (!data || !data.length) return ok(`No knowledge found matching "${query}".`);

            const lines = (data as Array<Record<string, unknown>>).map((k, i) => {
                const m = (k.metadata || {}) as Record<string, unknown>;
                const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
                return [
                    `--- ${i + 1}. ${k.title} (${k.kind}${k.repo_id ? "" : ", global"}) ${((k.similarity as number) * 100).toFixed(0)}% ---`,
                    tags ? `Topics: ${tags}` : "",
                    `\n${k.body}`,
                ]
                    .filter(Boolean)
                    .join("\n");
            });
            return ok(lines.join("\n\n"));
        } catch (e) {
            return err(`search_knowledge error: ${(e as Error).message}`);
        }
    }
);

// --- Hono App with Auth + CORS (same shape as open-brain-mcp) ---
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type, x-brain-key, x-access-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.get("*", (c) =>
    c.json({ status: "ok", service: "dev-context MCP", version: "1.0.0" }, 200, corsHeaders)
);

app.post("*", async (c) => {
    const provided =
        c.req.header("x-brain-key") ||
        c.req.header("x-access-key") ||
        new URL(c.req.url).searchParams.get("key");
    if (!provided || provided !== MCP_ACCESS_KEY) {
        let id: string | number | null = null;
        try {
            const body = await c.req.raw.clone().json();
            if (body && typeof body === "object" && "id" in body) {
                const bid = (body as { id: unknown }).id;
                if (typeof bid === "string" || typeof bid === "number" || bid === null) id = bid;
            }
        } catch {
            // Keep the auth response JSON-RPC-shaped even if the body is not JSON.
        }
        return c.json(
            { jsonrpc: "2.0", id, error: { code: -32001, message: "Invalid or missing access key" } },
            401,
            corsHeaders
        );
    }

    // Some clients omit the SSE Accept header StreamableHTTPTransport requires.
    if (!c.req.header("accept")?.includes("text/event-stream")) {
        const headers = new Headers(c.req.raw.headers);
        headers.set("Accept", "application/json, text/event-stream");
        const patched = new Request(c.req.raw.url, {
            method: c.req.raw.method,
            headers,
            body: c.req.raw.body,
            // @ts-ignore -- duplex required for streaming body in Deno
            duplex: "half",
        });
        Object.defineProperty(c.req, "raw", { value: patched, writable: true });
    }

    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
});

app.all("*", (c) => c.json({ error: "Method not allowed" }, 405, corsHeaders));

Deno.serve(app.fetch);

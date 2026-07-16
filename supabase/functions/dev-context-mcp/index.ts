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
// Optional — base URL of the org's Jira site (e.g. "https://yourco.atlassian.net"),
// used to turn a bare ticket key into a clickable link. Without it, bare keys
// render as plain text (full URLs stored in jira_ticket always work either way).
const JIRA_SITE_URL = Deno.env.get("JIRA_SITE_URL") || "";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Types ---
type ConfluenceDoc = { url: string; title?: string };

type Plan = {
    id: string;
    repo_id: string;
    title: string;
    focus: string;
    branch: string | null;
    worktree_path: string | null;
    status: string;
    kind: string;
    ticket_ref: string | null;
    parent_plan_id: string | null;
    cursor_phase_id: string | null;
    cursor_step_id: string | null;
    position_note: string;
    updated_at: string;
    jira_ticket: string | null;
    confluence_docs: ConfluenceDoc[];
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

// A tracked agent session, keyed on a caller-reported ambient terminal ref
// (e.g. a cmux 'workspace:12' ref from the cmux `identify` tool). Not tied to
// any particular multiplexer — `source`/`host` disambiguate.
type Session = {
    id: string;
    repo_id: string;
    plan_id: string | null;
    parent_session_id: string | null;
    session_ref: string;
    source: string;
    host: string;
    role: string;
    title: string;
    status: string; // running | idle | blocked | waiting_input | done | failed
    activity: string;
    started_at: string;
    last_heartbeat_at: string;
    ended_at: string | null;
};

// A plan annotated with rolled-up phase/step counts, for the overview dashboard.
type PlanOverviewRow = {
    id: string;
    repo_id: string;
    title: string;
    kind: string;
    status: string;
    ticket_ref: string | null;
    parent_plan_id: string | null;
    updated_at: string;
    total_phases: number;
    done_phases: number;
    total_steps: number;
    done_steps: number;
    current_phase_title: string | null;
};

export const DEFAULT_INITIAL_PLANNING_PHASE_TITLE = "Spec and plan work";
export const DEFAULT_PLAN_KIND = "sprint";

// Sprint work defaults to a scaffolded spec/plan phase (full engineering rigor
// starts with a spec). Looser kinds (spike, maintenance) default to no
// scaffold — an explicit scaffoldPlanningPhase always wins either way.
export function shouldCreateInitialPlanningPhase(
    scaffoldPlanningPhase?: boolean,
    kind?: string
): boolean {
    if (scaffoldPlanningPhase !== undefined) return scaffoldPlanningPhase;
    return (kind || DEFAULT_PLAN_KIND) === DEFAULT_PLAN_KIND;
}

export function buildInitialPlanningPhaseInsert(planId: string) {
    return {
        plan_id: planId,
        title: DEFAULT_INITIAL_PLANNING_PHASE_TITLE,
        status: "active",
        order_index: 0,
    };
}

// Free-form Jira reference (bare key like "NOC-2359" or a full URL) — not
// validated against any one Jira site's format. Empty/missing means unset.
export function normalizeJiraTicket(jiraTicket?: string | null): string | null {
    return jiraTicket ? jiraTicket : null;
}

export function formatJiraSuffix(jiraTicket?: string | null): string {
    return jiraTicket ? ` (Jira: ${jiraTicket})` : "";
}

// Resolves a freeform jira_ticket (bare key or full URL) to a browsable URL, or
// null when it can't be resolved (no ticket, or a bare key with no site configured).
export function jiraUrl(jiraTicket?: string | null, siteUrl?: string | null): string | null {
    if (!jiraTicket) return null;
    if (/^https?:\/\//i.test(jiraTicket)) return jiraTicket;
    if (!siteUrl) return null;
    return `${siteUrl.replace(/\/+$/, "")}/browse/${jiraTicket}`;
}

// Markdown-friendly rendering: a link when a URL resolves, otherwise the bare
// ticket text, otherwise empty.
export function formatJiraLink(jiraTicket?: string | null, siteUrl?: string | null): string {
    if (!jiraTicket) return "";
    const url = jiraUrl(jiraTicket, siteUrl);
    return url ? `[${jiraTicket}](${url})` : jiraTicket;
}

export function normalizeConfluenceDocs(docs?: ConfluenceDoc[] | null): ConfluenceDoc[] {
    if (!docs || !Array.isArray(docs)) return [];
    return docs
        .filter((d) => d && typeof d.url === "string" && d.url.trim())
        .map((d) => ({ url: d.url.trim(), ...(d.title?.trim() ? { title: d.title.trim() } : {}) }));
}

// Markdown bullet lines, one per doc — empty array when none attached.
export function formatConfluenceDocs(docs?: ConfluenceDoc[] | null): string[] {
    return normalizeConfluenceDocs(docs).map((d) => `- [${d.title || d.url}](${d.url})`);
}

// Small glanceable symbol for a plan/phase/step/session status — the raw
// [status] text is always kept alongside this, never replaced by it.
export function statusIcon(status: string): string {
    switch (status) {
        case "active":
        case "in_progress":
        case "running":
            return "🟢";
        case "done":
            return "✅";
        case "upcoming":
        case "todo":
            return "⬜";
        case "paused":
            return "⏸️";
        case "blocked":
            return "🔴";
        case "failed":
            return "❌";
        case "waiting_input":
            return "⏳";
        case "idle":
            return "💤";
        default:
            return "•";
    }
}

export function buildPlanInsert(params: {
    repoId: string;
    title: string;
    focus?: string;
    branch?: string;
    worktree?: string;
    kind?: string;
    ticketRef?: string;
    parentPlanId?: string;
    jiraTicket?: string;
    confluenceDocs?: ConfluenceDoc[];
}) {
    return {
        repo_id: params.repoId,
        title: params.title,
        focus: params.focus || "",
        branch: params.branch || null,
        worktree_path: params.worktree || null,
        kind: params.kind || DEFAULT_PLAN_KIND,
        ticket_ref: params.ticketRef || null,
        parent_plan_id: params.parentPlanId || null,
        jira_ticket: normalizeJiraTicket(params.jiraTicket),
        confluence_docs: normalizeConfluenceDocs(params.confluenceDocs),
    };
}

// --- Active session context ---
// `active` is a warm-isolate cache: connect() sets it, cursor tools read it
// for zero-latency access. But Supabase Edge Functions give no session
// affinity across requests, so a cold/different isolate can't see it — those
// calls fall back to the `active_context` table, which connect() (and every
// tool that changes the active plan) keeps durable. Tools also still accept
// explicit repo/plan overrides for callers that want to bypass all of this.
let active: { repoId: string | null; planId: string | null } = {
    repoId: null,
    planId: null,
};

// --- Per-machine repo exclusion ---
// A machine can send `x-exclude-repos` (comma-separated repo_ids) to hide
// specific repos from cross-repo tools (overview, list_sessions,
// search_knowledge scope=all) without those repos ever being un-fetched from
// the shared backend for *other* machines. Set per-request in app.post, same
// warm-isolate-cache pattern as `active` above.
let requestExcludeRepos: string[] = [];

export function parseExcludeRepos(header?: string | null): string[] {
    if (!header) return [];
    return header
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

export function isRepoExcluded(repoId: string | null | undefined, exclude: string[]): boolean {
    if (!repoId || !exclude.length) return false;
    return exclude.includes(repoId);
}

export function sessionKey(host?: string | null, session_ref?: string | null): string {
    return session_ref ? `${host ?? ""}\0${session_ref}` : "__default__";
}

// Persists the active repo/plan so a cold isolate can recover it. Always
// refreshes the `__default__` row (session-less callers recover the latest
// connect) and, when a session_ref is known, also writes a per-session row.
async function persistActive(params: {
    repoId: string;
    planId?: string | null;
    session_ref?: string | null;
    host?: string | null;
}) {
    const { repoId, planId = null, session_ref, host } = params;
    active = { repoId, planId };
    const now = new Date().toISOString();
    const rows = [{ session_key: "__default__", repo_id: repoId, plan_id: planId, updated_at: now }];
    if (session_ref) {
        rows.push({ session_key: sessionKey(host, session_ref), repo_id: repoId, plan_id: planId, updated_at: now });
    }
    await supabase.from("active_context").upsert(rows, { onConflict: "session_key" });
}

async function fetchActiveContextRow(
    session_ref?: string | null,
    host?: string | null
): Promise<{ repo_id: string; plan_id: string | null } | null> {
    if (session_ref) {
        const { data } = await supabase
            .from("active_context")
            .select("repo_id, plan_id")
            .eq("session_key", sessionKey(host, session_ref))
            .maybeSingle();
        if (data) return data;
    }
    const { data } = await supabase
        .from("active_context")
        .select("repo_id, plan_id")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    return data ?? null;
}

// Resolves the active repo id: explicit override > warm cache > durable
// fallback. Refreshes the warm cache from the DB row when it was used, so a
// cold isolate only pays the DB lookup once per warm-up.
export async function resolveActiveRepoId(
    explicit?: string | null,
    opts?: { session_ref?: string | null; host?: string | null }
): Promise<string | null> {
    if (explicit) {
        active = { repoId: explicit, planId: active.planId };
        return explicit;
    }
    if (active.repoId) return active.repoId;
    const row = await fetchActiveContextRow(opts?.session_ref, opts?.host);
    if (!row) return null;
    active = { repoId: row.repo_id, planId: row.plan_id };
    return row.repo_id;
}

// Resolves the active plan id: explicit override > warm cache > durable
// fallback. Unlike resolveActiveRepoId, an explicit plan_id override does not
// imply anything about the repo, so it doesn't touch the repoId half of the
// cache.
export async function resolveActivePlanId(
    explicit?: string | null,
    opts?: { session_ref?: string | null; host?: string | null }
): Promise<string | null> {
    if (explicit) return explicit;
    if (active.planId) return active.planId;
    const row = await fetchActiveContextRow(opts?.session_ref, opts?.host);
    if (!row) return null;
    active = { repoId: row.repo_id, planId: row.plan_id };
    return row.plan_id;
}

async function requireActiveRepoId(
    explicit?: string | null,
    opts?: { session_ref?: string | null; host?: string | null }
): Promise<string> {
    const repoId = await resolveActiveRepoId(explicit, opts);
    if (!repoId) {
        throw new Error("No active repo. Call connect(repo) first.");
    }
    return repoId;
}

const BASE_WORKING_CONTRACT = `--- dev-context working contract ---
You are working under dev-context for this repo. Maintain the plan as you work, without being asked:
- When a task isn't represented in the plan, decompose it into steps and add_step them (surface what you added, don't wait for approval).
- As you complete meaningful work, call complete_step and keep position_note current via update_progress.
- When a phase is fully done, propose complete_phase to the user first (it archives + summarizes the phase).
- To work on a different repo or line of work, name it explicitly (connect / switch_plan).`;

// Per-kind addendum to the base contract. Freeform: unknown kinds just get the
// base contract with no addendum.
const KIND_CONTRACT_ADDENDA: Record<string, string> = {
    sprint:
        "- This is sprint work: hold to full engineering rigor — tests, review-quality code, and a clear definition of done — before calling complete_phase.",
    spike:
        "- This is a spike: move fast and prove the point. Skip heavy test coverage and polish — the goal is a clear answer or working prototype plus a written report, not production code.",
    maintenance:
        '- This is a maintenance loop: keep scanning (tickets, error logs, flaky tests) for things to fix or flag. For each concrete fix, call create_plan with parent_plan_id set to this plan (kind "sprint" or "spike") rather than fixing inline — keep this plan itself long-running and lightweight.',
    investigation:
        "- This is an investigation: ticket-driven, but the outcome may be a written finding, root-cause report, or recommendation rather than a code change — don't assume code is the deliverable. Read logs, dig through code history, and query whatever other systems (Jira, Confluence, dashboards, databases) you need before concluding anything. If you're missing data or access you don't have and don't know how to get, stop and ask the user by name rather than guessing, stalling, or fabricating a plausible-sounding answer.",
};

export function workingContractFor(kind?: string | null): string {
    const addendum = KIND_CONTRACT_ADDENDA[kind || DEFAULT_PLAN_KIND];
    return addendum ? `${BASE_WORKING_CONTRACT}\n${addendum}` : BASE_WORKING_CONTRACT;
}

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

// --- Orchestration helpers (pure — no DB access, unit-testable) ---
export const SESSION_STALE_MS = 10 * 60 * 1000; // 10 minutes
export const PLAN_STALE_DAYS = 7;

export function isSessionStale(
    lastHeartbeatAt: string,
    nowMs: number,
    staleMs: number = SESSION_STALE_MS
): boolean {
    return nowMs - new Date(lastHeartbeatAt).getTime() > staleMs;
}

export function isPlanStale(
    updatedAt: string,
    nowMs: number,
    staleDays: number = PLAN_STALE_DAYS
): boolean {
    return nowMs - new Date(updatedAt).getTime() > staleDays * 24 * 60 * 60 * 1000;
}

export function formatHeartbeatAge(lastHeartbeatAt: string, nowMs: number): string {
    const ms = nowMs - new Date(lastHeartbeatAt).getTime();
    if (ms < 60_000) return "just now";
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

// Generic parent/child forest builder, shared by the session tree and plan
// tree renderers. Items whose declared parent isn't in the given set (ended
// parent filtered out, dangling ref, etc.) are treated as roots rather than
// silently dropped.
function renderForest<T extends { id: string }>(
    items: T[],
    parentIdOf: (item: T) => string | null,
    lineFor: (item: T, depth: number) => string
): string[] {
    const knownIds = new Set(items.map((i) => i.id));
    const childrenOf = new Map<string, T[]>();
    const roots: T[] = [];
    for (const item of items) {
        const pid = parentIdOf(item);
        if (pid && knownIds.has(pid)) {
            if (!childrenOf.has(pid)) childrenOf.set(pid, []);
            childrenOf.get(pid)!.push(item);
        } else {
            roots.push(item);
        }
    }
    const lines: string[] = [];
    const visit = (item: T, depth: number) => {
        lines.push(lineFor(item, depth));
        for (const child of childrenOf.get(item.id) || []) visit(child, depth + 1);
    };
    for (const r of roots) visit(r, 0);
    return lines;
}

export function renderSessionTree(
    sessions: Session[],
    nowMs: number,
    staleMs: number = SESSION_STALE_MS
): string {
    if (!sessions.length) return "(no sessions)";
    const lines = renderForest(
        sessions,
        (s) => s.parent_session_id,
        (s, depth) => {
            const indent = "  ".repeat(depth);
            const stale = s.status === "running" && isSessionStale(s.last_heartbeat_at, nowMs, staleMs);
            const label = s.title || s.session_ref;
            return (
                `${indent}- ${statusIcon(s.status)} [${s.status}] ${s.role}/${label}` +
                `${s.plan_id ? ` (plan ${s.plan_id})` : ""}` +
                `${s.activity ? ` — ${s.activity}` : ""}` +
                ` · ${formatHeartbeatAge(s.last_heartbeat_at, nowMs)}${stale ? " ⚠ stale" : ""}`
            );
        }
    );
    return lines.join("\n");
}

export function isSessionAttentionNeeded(
    s: Session,
    nowMs: number,
    staleMs: number = SESSION_STALE_MS
): { flag: boolean; reason: string | null } {
    if (s.status === "waiting_input") return { flag: true, reason: "waiting on input" };
    if (s.status === "failed") return { flag: true, reason: "failed" };
    if (s.status === "running" && isSessionStale(s.last_heartbeat_at, nowMs, staleMs)) {
        return { flag: true, reason: "no heartbeat — possibly stuck" };
    }
    return { flag: false, reason: null };
}

export function isPlanAttentionNeeded(
    plan: PlanOverviewRow,
    nowMs: number,
    staleDays: number = PLAN_STALE_DAYS
): { flag: boolean; reason: string | null } {
    if (plan.status === "blocked") return { flag: true, reason: "blocked" };
    if (plan.status === "paused") return { flag: true, reason: "paused" };
    if (plan.status === "active" && isPlanStale(plan.updated_at, nowMs, staleDays)) {
        return { flag: true, reason: `stale — no update in ${staleDays}+ days` };
    }
    return { flag: false, reason: null };
}

export function renderPlanLine(plan: PlanOverviewRow): string {
    const pct = plan.total_steps ? Math.round((plan.done_steps / plan.total_steps) * 100) : 0;
    const parts = [
        `${statusIcon(plan.status)} [${plan.kind}] ${plan.title}`,
        `(${plan.status}${plan.ticket_ref ? `, ${plan.ticket_ref}` : ""})`,
        `— phase ${plan.done_phases}/${plan.total_phases}, ${pct}% steps done`,
    ];
    if (plan.current_phase_title) parts.push(`· now: ${plan.current_phase_title}`);
    return parts.join(" ");
}

export function renderPlanTree(
    plans: PlanOverviewRow[],
    nowMs: number,
    staleDays: number = PLAN_STALE_DAYS
): string {
    if (!plans.length) return "(no plans)";
    const lines = renderForest(
        plans,
        (p) => p.parent_plan_id,
        (p, depth) => {
            const indent = "  ".repeat(depth);
            const attn = isPlanAttentionNeeded(p, nowMs, staleDays);
            return `${indent}${renderPlanLine(p)}${attn.flag ? ` ⚠ ${attn.reason}` : ""}`;
        }
    );
    return lines.join("\n");
}

export function renderAttentionSection(
    plans: PlanOverviewRow[],
    sessions: Session[],
    nowMs: number
): string {
    const flaggedPlans = plans
        .map((p) => ({ p, attn: isPlanAttentionNeeded(p, nowMs) }))
        .filter((x) => x.attn.flag);
    const flaggedSessions = sessions
        .map((s) => ({ s, attn: isSessionAttentionNeeded(s, nowMs) }))
        .filter((x) => x.attn.flag);
    if (!flaggedPlans.length && !flaggedSessions.length) return "Nothing needs attention.";
    const lines: string[] = [];
    for (const { p, attn } of flaggedPlans) {
        lines.push(`- [plan] ${p.title} (${p.repo_id}) — ${attn.reason}`);
    }
    for (const { s, attn } of flaggedSessions) {
        lines.push(`- [session] ${s.title || s.session_ref} (${s.repo_id}) — ${attn.reason}`);
    }
    return lines.join("\n");
}

// --- Data helpers ---
function ok(text: string) {
    return { content: [{ type: "text" as const, text }] };
}
function err(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true };
}

async function loadPlan(planId: string): Promise<Plan | null> {
    const { data } = await supabase.from("plans").select("*").eq("id", planId).single();
    return (data as Plan) || null;
}

// The step a caller should be working on right now, given a phase's steps:
// an in_progress step wins (someone's already on it), otherwise the first
// not-done step in order. Null when every step is done (or there are none).
export function findCurrentStep(steps: Step[]): Step | null {
    const sorted = [...steps].sort((a, b) => a.order_index - b.order_index);
    return (
        sorted.find((s) => s.status === "in_progress") ||
        sorted.find((s) => s.status !== "done") ||
        null
    );
}

// Resolves which step complete_step/update_progress should act on for a
// given (already-resolved) phase, self-healing when the plan's stored
// cursor_step_id has gone stale — e.g. it points at a step that's done or
// belongs to a different phase, or it's null even though the phase plainly
// has open steps (this happens whenever a phase becomes the cursor phase
// before it has any steps yet — complete_phase transitioning into a
// not-yet-populated phase — and a later add_step call didn't win the
// cursor-adoption race). `healed` tells the caller whether the resolved
// step differs from `plan.cursor_step_id` and so needs to be persisted back.
export function resolveCursorStep(
    plan: Pick<Plan, "cursor_phase_id" | "cursor_step_id">,
    phaseId: string,
    phaseSteps: Step[]
): { stepId: string; healed: boolean } | null {
    if (plan.cursor_phase_id === phaseId && plan.cursor_step_id) {
        const claimed = phaseSteps.find((s) => s.id === plan.cursor_step_id && s.status !== "done");
        if (claimed) return { stepId: claimed.id, healed: false };
    }
    const current = findCurrentStep(phaseSteps);
    return current ? { stepId: current.id, healed: true } : null;
}

// Resolves the plan's current phase id, self-healing when cursor_phase_id is
// null (or stale) by falling back to whichever phase is actually marked
// 'active' in the DB.
async function resolveCurrentPhaseId(
    planId: string,
    plan: Pick<Plan, "cursor_phase_id">
): Promise<string | null> {
    if (plan.cursor_phase_id) return plan.cursor_phase_id;
    const { data } = await supabase
        .from("phases")
        .select("id")
        .eq("plan_id", planId)
        .eq("status", "active")
        .order("order_index", { ascending: true })
        .limit(1);
    return (data || [])[0]?.id ?? null;
}

// Shared by the register_session tool and connect() (which auto-registers the
// caller's session, if it reports one, in the same call that resolves the plan).
async function registerSessionRow(params: {
    repoId: string;
    sessionRef: string;
    source?: string;
    host?: string;
    planId?: string | null;
    parentSessionRef?: string;
    role?: string;
    title?: string;
}): Promise<{ id: string; error?: string }> {
    const host = params.host || "";
    let parentSessionId: string | null = null;
    if (params.parentSessionRef) {
        const { data: parent } = await supabase
            .from("agent_sessions")
            .select("id")
            .eq("host", host)
            .eq("session_ref", params.parentSessionRef)
            .maybeSingle();
        parentSessionId = parent?.id || null;
    }
    const { data, error } = await supabase
        .from("agent_sessions")
        .upsert(
            {
                repo_id: params.repoId,
                plan_id: params.planId || null,
                parent_session_id: parentSessionId,
                session_ref: params.sessionRef,
                source: params.source || "cmux",
                host,
                role: params.role || "worker",
                title: params.title || "",
                status: "running",
                last_heartbeat_at: new Date().toISOString(),
                ended_at: null,
            },
            { onConflict: "host,session_ref" }
        )
        .select("id")
        .single();
    if (error) return { id: "", error: error.message };
    return { id: data.id };
}

async function renderActivePlan(plan: Plan): Promise<string> {
    const lines: string[] = [`### ${statusIcon(plan.status)} Active plan: ${plan.title}`];
    lines.push(`**Kind:** ${plan.kind}`);
    if (plan.focus) lines.push(`**Focus:** ${plan.focus}`);
    if (plan.branch) lines.push(`**Branch:** ${plan.branch}`);
    if (plan.ticket_ref) lines.push(`**Ticket:** ${plan.ticket_ref}`);
    if (plan.parent_plan_id) lines.push(`**Parent plan:** ${plan.parent_plan_id}`);
    const jiraLink = formatJiraLink(plan.jira_ticket, JIRA_SITE_URL);
    if (jiraLink) lines.push(`🎫 **Jira:** ${jiraLink}`);
    const confluenceLines = formatConfluenceDocs(plan.confluence_docs);
    if (confluenceLines.length) lines.push("📄 **Confluence:**", ...confluenceLines);

    const { data: phases } = await supabase
        .from("phases")
        .select("*")
        .eq("plan_id", plan.id)
        .order("order_index", { ascending: true });

    const phaseList = (phases || []) as Phase[];
    lines.push("", "---", "**Phases:**");
    for (const ph of phaseList) {
        const marker = ph.id === plan.cursor_phase_id ? "→" : " ";
        const label =
            ph.status === "done" && ph.rollup ? `done — ${ph.rollup.split("\n")[0]}` : ph.status;
        lines.push(`${marker} ${statusIcon(ph.status)} [${label}] ${ph.title}`);
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
            lines.push("", "---", "**Current phase steps:**");
            for (const s of stepList) {
                const marker = s.id === plan.cursor_step_id ? "→" : " ";
                lines.push(`${marker} ${statusIcon(s.status)} [${s.status}] ${s.title}`);
            }
            // Current step full detail + position note
            const cur = stepList.find((s) => s.id === plan.cursor_step_id);
            if (cur) {
                lines.push("", `**Current step:** ${cur.title}`);
                if (cur.detail) lines.push(cur.detail);
            }
        }
    }
    if (plan.position_note) lines.push("", `📍 **You are here:** ${plan.position_note}`);
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
            "Connect to a repo's dev-context at session start. Resolves the active plan from the current git branch/worktree and returns architecture, plan/idea titles, and the active plan's current slice. Call this first. If you have an ambient terminal ref (e.g. from the cmux `identify` tool), pass session_ref/host so this session is registered and trackable via list_sessions/overview — pass parent_session_ref if an orchestrator spawned you.",
        inputSchema: {
            repo: z.string().describe("Repo identifier, e.g. 'owner/name'"),
            branch: z.string().optional().describe("Current git branch"),
            worktree: z.string().optional().describe("Current worktree path"),
            session_ref: z
                .string()
                .optional()
                .describe("Ambient terminal ref for this session, e.g. cmux workspace_ref/surface_ref from identify"),
            source: z.string().optional().describe("Terminal source, default 'cmux'"),
            host: z.string().optional().describe("Disambiguator across machines, e.g. cmux socket_path"),
            role: z.string().optional().describe("'orchestrator' | 'worker' | freeform, default 'worker'"),
            title: z.string().optional().describe("Short label for this session"),
            parent_session_ref: z
                .string()
                .optional()
                .describe("session_ref of the orchestrator/parent session, if this one was spawned"),
        },
    },
    async ({ repo, branch, worktree, session_ref, source, host, role, title, parent_session_ref }) => {
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
                .select("id, title, branch, status, kind, ticket_ref, parent_plan_id, jira_ticket")
                .eq("repo_id", repo)
                .order("updated_at", { ascending: false });
            const planList = (plans || []) as Pick<
                Plan,
                "id" | "title" | "branch" | "status" | "kind" | "ticket_ref" | "parent_plan_id" | "jira_ticket"
            >[];

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

            await persistActive({ repoId: repo, planId: activePlan?.id || null, session_ref, host });

            let sessionNote = "";
            if (session_ref) {
                const result = await registerSessionRow({
                    repoId: repo,
                    sessionRef: session_ref,
                    source,
                    host,
                    planId: activePlan?.id,
                    parentSessionRef: parent_session_ref,
                    role,
                    title,
                });
                sessionNote = result.error
                    ? `\n(session registration failed: ${result.error})`
                    : `\n(session registered: ${session_ref})`;
            }

            const out: string[] = [`# 📦 dev-context: ${repo}`];
            out.push(
                "",
                "---",
                "## Architecture",
                repoRow?.architecture_doc?.trim() || "(none yet — use update_architecture to set it)"
            );

            out.push("", "---", "## Plans");
            if (planList.length) {
                for (const p of planList) {
                    const marker = p.id === activePlan?.id ? "→" : " ";
                    const tags = [p.kind, p.ticket_ref, p.branch].filter(Boolean).join(", ");
                    const jiraLink = formatJiraLink(p.jira_ticket, JIRA_SITE_URL);
                    out.push(
                        `${marker} ${statusIcon(p.status)} ${p.title} [${p.status}${tags ? `, ${tags}` : ""}]${jiraLink ? ` (Jira: ${jiraLink})` : ""}${p.parent_plan_id ? ` (child of ${p.parent_plan_id})` : ""} (id: ${p.id})`
                    );
                }
            } else {
                out.push("(no plans yet — create_plan to start one)");
            }

            if (ideas && ideas.length) {
                out.push("", "---", "## Ideas");
                for (const i of ideas) out.push(`- ${i.title} (id: ${i.id})`);
            }

            const { data: sessionRows } = await supabase
                .from("agent_sessions")
                .select("*")
                .eq("repo_id", repo)
                .is("ended_at", null)
                .order("started_at", { ascending: true });
            if (sessionRows && sessionRows.length) {
                out.push("", "---", "## Active sessions", renderSessionTree(sessionRows as Session[], Date.now()));
            }

            out.push("", "---");
            if (activePlan) {
                out.push(await renderActivePlan(activePlan) + sessionNote);
            } else if (branch) {
                out.push(
                    `No plan bound to branch "${branch}". Offer to create_plan(title, focus, branch="${branch}") if starting new work here.${sessionNote}`
                );
            } else {
                out.push(`No active plan resolved. Use switch_plan or create_plan.${sessionNote}`);
            }

            out.push("", "---", workingContractFor(activePlan?.kind));
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
            const lines = [
                `Plan: ${plan.title}${formatJiraSuffix(plan.jira_ticket)}`,
                `Focus: ${plan.focus}`,
                `Status: ${plan.status}`,
            ];
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
            'Create a new plan (line of work) in the active repo, optionally bound to a git branch. Becomes the active plan. `kind` shapes agent behavior via the working contract injected at connect — starter set: "sprint" (branch + ticket, full engineering rigor, default), "spike" (loose plan, quick-and-dirty exploration/research), "maintenance" (long-running loop that spawns child plans per fix via parent_plan_id), "investigation" (ticket-driven, outcome may be a report/finding rather than code, ask the user when data or access is missing). Freeform — any kind is accepted.',
        inputSchema: {
            title: z.string(),
            focus: z.string().optional(),
            branch: z.string().optional(),
            worktree: z.string().optional(),
            kind: z
                .string()
                .optional()
                .describe('Work style: "sprint" (default) | "spike" | "maintenance" | "investigation" | freeform'),
            ticket_ref: z.string().optional().describe("External ticket reference, e.g. a Jira key"),
            parent_plan_id: z
                .string()
                .optional()
                .describe("Parent plan id, e.g. the maintenance-loop plan this fix was spawned from"),
            scaffold_planning_phase: z
                .boolean()
                .optional()
                .describe(
                    "When true, create an initial active phase for spec and planning work. Defaults to true for kind='sprint', false for other kinds."
                ),
            repo_id: z.string().optional().describe("Explicit repo override for stateless callers"),
            jira_ticket: z
                .string()
                .optional()
                .describe("Jira ticket reference to attach, e.g. 'NOC-2359' or a full URL"),
            confluence_docs: z
                .array(z.object({ url: z.string(), title: z.string().optional() }))
                .optional()
                .describe("Confluence docs to attach: array of { url, title? }"),
        },
    },
    async ({
        title,
        focus,
        branch,
        worktree,
        kind,
        ticket_ref,
        parent_plan_id,
        scaffold_planning_phase,
        repo_id,
        jira_ticket,
        confluence_docs,
    }) => {
        try {
            const repoId = await requireActiveRepoId(repo_id);
            const planKind = kind || DEFAULT_PLAN_KIND;
            const { data, error } = await supabase
                .from("plans")
                .insert(
                    buildPlanInsert({
                        repoId,
                        title,
                        focus,
                        branch,
                        worktree,
                        kind: planKind,
                        ticketRef: ticket_ref,
                        parentPlanId: parent_plan_id,
                        jiraTicket: jira_ticket,
                        confluenceDocs: confluence_docs,
                    })
                )
                .select("id")
                .single();
            if (error) return err(`create_plan error: ${error.message}`);
            await persistActive({ repoId, planId: data.id });

            let initialPhaseText = "";
            if (shouldCreateInitialPlanningPhase(scaffold_planning_phase, planKind)) {
                const { data: phase, error: phaseError } = await supabase
                    .from("phases")
                    .insert(buildInitialPlanningPhaseInsert(data.id))
                    .select("id")
                    .single();
                if (phaseError) return err(`create_plan error: ${phaseError.message}`);
                await supabase
                    .from("plans")
                    .update({
                        cursor_phase_id: phase.id,
                        position_note: "Start by clarifying scope, writing the spec, and decomposing the work.",
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", data.id);
                initialPhaseText = ` Initial phase: "${DEFAULT_INITIAL_PLANNING_PHASE_TITLE}".`;
            }

            return ok(
                `Created ${planKind} plan "${title}" (id: ${data.id})${branch ? ` bound to ${branch}` : ""}${ticket_ref ? `, ${ticket_ref}` : ""}${parent_plan_id ? `, child of ${parent_plan_id}` : ""}${formatJiraSuffix(jira_ticket)}. It is now active.${initialPhaseText}`
            );
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
            await persistActive({ repoId: plan.repo_id, planId: plan.id });
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
            const target = await resolveActivePlanId(plan_id);
            if (!target) return err("No active plan. Use switch_plan or create_plan.");
            await supabase.from("plans").update({ focus: text, updated_at: new Date().toISOString() }).eq("id", target);
            return ok(`Focus updated.`);
        } catch (e) {
            return err(`update_focus error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "update_jira_ticket",
    {
        title: "Update plan Jira ticket",
        description:
            "Set, change, or clear the Jira ticket reference on a plan (free-form: a bare key like 'NOC-2359' or a full URL). Pass an empty string to clear.",
        inputSchema: {
            jira_ticket: z
                .string()
                .describe("Jira ticket reference, e.g. 'NOC-2359' or a full URL. Pass an empty string to clear."),
            plan_id: z.string().optional().describe("Explicit plan override for stateless callers"),
        },
    },
    async ({ jira_ticket, plan_id }) => {
        try {
            const target = await resolveActivePlanId(plan_id);
            if (!target) return err("No active plan. Use switch_plan or create_plan.");
            const value = normalizeJiraTicket(jira_ticket);
            await supabase
                .from("plans")
                .update({ jira_ticket: value, updated_at: new Date().toISOString() })
                .eq("id", target);
            return ok(value ? `Jira ticket set to ${value}.` : "Jira ticket cleared.");
        } catch (e) {
            return err(`update_jira_ticket error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "update_confluence_docs",
    {
        title: "Update plan Confluence docs",
        description:
            "Replace the Confluence docs attached to a plan (array of { url, title? }). Pass an empty array to clear.",
        inputSchema: {
            docs: z
                .array(z.object({ url: z.string(), title: z.string().optional() }))
                .describe("Confluence docs to attach, e.g. [{ url, title? }]. Pass [] to clear."),
            plan_id: z.string().optional().describe("Explicit plan override for stateless callers"),
        },
    },
    async ({ docs, plan_id }) => {
        try {
            const target = await resolveActivePlanId(plan_id);
            if (!target) return err("No active plan. Use switch_plan or create_plan.");
            const value = normalizeConfluenceDocs(docs);
            await supabase
                .from("plans")
                .update({ confluence_docs: value, updated_at: new Date().toISOString() })
                .eq("id", target);
            return ok(value.length ? `Confluence docs set (${value.length}).` : "Confluence docs cleared.");
        } catch (e) {
            return err(`update_confluence_docs error: ${(e as Error).message}`);
        }
    }
);

// --- Agent sessions (live orchestration tracking) ---
server.registerTool(
    "register_session",
    {
        title: "Register agent session",
        description:
            "Register (or re-register) a running agent as a trackable session, keyed on an ambient terminal ref (e.g. a cmux `workspace:N`/`surface:N` ref from the cmux `identify` tool) rather than an invented id. Pass parent_session_ref to attach as a child of the session that spawned you, building a live orchestration tree visible via list_sessions/overview. connect() does this automatically if you pass it session args — call this directly only to (re)register mid-session or to register a spawned child.",
        inputSchema: {
            session_ref: z
                .string()
                .describe("Stable ref for this session, e.g. a cmux workspace_ref/surface_ref from identify"),
            source: z.string().optional().describe("Terminal source, default 'cmux'"),
            host: z.string().optional().describe("Disambiguator across machines, e.g. cmux socket_path"),
            role: z.string().optional().describe("'orchestrator' | 'worker' | freeform, default 'worker'"),
            title: z.string().optional().describe("Short label for this session"),
            plan_id: z.string().optional().describe("Plan this session is working, if any"),
            parent_session_ref: z
                .string()
                .optional()
                .describe("session_ref of the orchestrator/parent session, if this one was spawned"),
            repo_id: z.string().optional().describe("Explicit repo override for stateless callers"),
        },
    },
    async ({ session_ref, source, host, role, title, plan_id, parent_session_ref, repo_id }) => {
        try {
            const repoId = await requireActiveRepoId(repo_id, { session_ref, host });
            const planId = (await resolveActivePlanId(plan_id, { session_ref, host })) || null;
            const result = await registerSessionRow({
                repoId,
                sessionRef: session_ref,
                source,
                host,
                planId,
                parentSessionRef: parent_session_ref,
                role,
                title,
            });
            if (result.error) return err(`register_session error: ${result.error}`);
            return ok(`Session registered (id: ${result.id}).`);
        } catch (e) {
            return err(`register_session error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "heartbeat_session",
    {
        title: "Heartbeat agent session",
        description:
            "Update a tracked agent session's status/activity and refresh its heartbeat. Call periodically as an agent works so its liveness and progress show up in list_sessions/overview. A 'running' session with no heartbeat for a while is flagged stale.",
        inputSchema: {
            id: z.string().optional().describe("Session id, if known"),
            session_ref: z.string().optional().describe("Session ref, if id is not known (with host)"),
            host: z.string().optional().describe("Host paired with session_ref"),
            status: z
                .enum(["running", "idle", "blocked", "waiting_input", "done", "failed"])
                .optional(),
            activity: z.string().optional().describe("Current 'you are here' one-liner"),
            plan_id: z.string().optional(),
        },
    },
    async ({ id, session_ref, host, status, activity, plan_id }) => {
        try {
            if (!id && !session_ref) return err("Provide id or session_ref.");
            const update: Record<string, unknown> = { last_heartbeat_at: new Date().toISOString() };
            if (status) update.status = status;
            if (activity !== undefined) update.activity = activity;
            if (plan_id !== undefined) update.plan_id = plan_id || null;

            let query = supabase.from("agent_sessions").update(update);
            query = id ? query.eq("id", id) : query.eq("host", host || "").eq("session_ref", session_ref!);
            const { data, error } = await query.select("id");
            if (error) return err(`heartbeat_session error: ${error.message}`);
            if (!data || !data.length) return err("Session not found — register_session first.");
            return ok("Heartbeat recorded.");
        } catch (e) {
            return err(`heartbeat_session error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "end_session",
    {
        title: "End agent session",
        description: "Mark a tracked agent session finished (done or failed) and stamp ended_at.",
        inputSchema: {
            id: z.string().optional().describe("Session id, if known"),
            session_ref: z.string().optional().describe("Session ref, if id is not known (with host)"),
            host: z.string().optional().describe("Host paired with session_ref"),
            status: z.enum(["done", "failed"]).optional().default("done"),
            note: z.string().optional().describe("Closing note, stored as the final activity"),
        },
    },
    async ({ id, session_ref, host, status, note }) => {
        try {
            if (!id && !session_ref) return err("Provide id or session_ref.");
            const update: Record<string, unknown> = {
                status,
                ended_at: new Date().toISOString(),
                last_heartbeat_at: new Date().toISOString(),
                ...(note ? { activity: note } : {}),
            };
            let query = supabase.from("agent_sessions").update(update);
            query = id ? query.eq("id", id) : query.eq("host", host || "").eq("session_ref", session_ref!);
            const { data, error } = await query.select("id");
            if (error) return err(`end_session error: ${error.message}`);
            if (!data || !data.length) return err("Session not found.");
            return ok(`Session marked ${status}.`);
        } catch (e) {
            return err(`end_session error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "list_sessions",
    {
        title: "List agent sessions",
        description:
            "List tracked agent sessions as a live orchestration tree (parent → spawned children), with status, current activity, and heartbeat staleness. Use to see what's currently running/blocked across a tree of agents. Omit repo_id to see every repo, grouped.",
        annotations: { readOnlyHint: true },
        inputSchema: {
            repo_id: z.string().optional().describe("Omit for all repos"),
            include_ended: z.boolean().optional().default(false),
        },
    },
    async ({ repo_id, include_ended }) => {
        try {
            let query = supabase.from("agent_sessions").select("*").order("started_at", { ascending: true });
            if (repo_id) query = query.eq("repo_id", repo_id);
            if (!include_ended) query = query.is("ended_at", null);
            const { data, error } = await query;
            if (error) return err(`list_sessions error: ${error.message}`);
            const sessions = ((data || []) as Session[]).filter(
                (s) => !isRepoExcluded(s.repo_id, requestExcludeRepos)
            );
            if (!sessions.length) return ok("No sessions.");

            const now = Date.now();
            if (repo_id) return ok(renderSessionTree(sessions, now));

            const byRepo = new Map<string, Session[]>();
            for (const s of sessions) {
                if (!byRepo.has(s.repo_id)) byRepo.set(s.repo_id, []);
                byRepo.get(s.repo_id)!.push(s);
            }
            const lines: string[] = [];
            for (const [repo, rows] of byRepo) {
                lines.push("---", `### 📦 ${repo}`, renderSessionTree(rows, now), "");
            }
            return ok(lines.join("\n").trim());
        } catch (e) {
            return err(`list_sessions error: ${(e as Error).message}`);
        }
    }
);

server.registerTool(
    "overview",
    {
        title: "Cross-repo work overview",
        description:
            "Dashboard: every plan's kind/status/progress, nested under its parent plan, across repos (or one repo) — plus an Attention section (blocked/paused/stale plans, sessions waiting on input or stuck) and the live agent session tree. Omit repo_id for a cross-repo rollup.",
        annotations: { readOnlyHint: true },
        inputSchema: {
            repo_id: z.string().optional().describe("Omit for all repos"),
            kind: z.string().optional().describe("Filter to one kind, e.g. 'sprint'"),
            include_done: z.boolean().optional().default(false),
        },
    },
    async ({ repo_id, kind, include_done }) => {
        try {
            let planQuery = supabase.from("plans").select("*");
            if (repo_id) planQuery = planQuery.eq("repo_id", repo_id);
            if (kind) planQuery = planQuery.eq("kind", kind);
            if (!include_done) planQuery = planQuery.neq("status", "done");
            const { data: planRows, error: planErr } = await planQuery;
            if (planErr) return err(`overview error: ${planErr.message}`);
            const plans = ((planRows || []) as Plan[]).filter(
                (p) => !isRepoExcluded(p.repo_id, requestExcludeRepos)
            );

            const planIds = plans.map((p) => p.id);
            const { data: phaseRows } = planIds.length
                ? await supabase.from("phases").select("id, plan_id, title, status").in("plan_id", planIds)
                : { data: [] as Array<Pick<Phase, "id" | "plan_id" | "title" | "status">> };
            const phases = (phaseRows || []) as Array<Pick<Phase, "id" | "plan_id" | "title" | "status">>;

            const phaseIds = phases.map((p) => p.id);
            const { data: stepRows } = phaseIds.length
                ? await supabase.from("steps").select("id, phase_id, status").in("phase_id", phaseIds)
                : { data: [] as Array<Pick<Step, "id" | "phase_id" | "status">> };
            const steps = (stepRows || []) as Array<Pick<Step, "id" | "phase_id" | "status">>;

            const phasesByPlan = new Map<string, typeof phases>();
            for (const ph of phases) {
                if (!phasesByPlan.has(ph.plan_id)) phasesByPlan.set(ph.plan_id, []);
                phasesByPlan.get(ph.plan_id)!.push(ph);
            }
            const stepsByPhase = new Map<string, typeof steps>();
            for (const s of steps) {
                if (!stepsByPhase.has(s.phase_id)) stepsByPhase.set(s.phase_id, []);
                stepsByPhase.get(s.phase_id)!.push(s);
            }

            const overviewRows: PlanOverviewRow[] = plans.map((p) => {
                const planPhases = phasesByPlan.get(p.id) || [];
                const planSteps = planPhases.flatMap((ph) => stepsByPhase.get(ph.id) || []);
                const current = planPhases.find((ph) => ph.id === p.cursor_phase_id);
                return {
                    id: p.id,
                    repo_id: p.repo_id,
                    title: p.title,
                    kind: p.kind,
                    status: p.status,
                    ticket_ref: p.ticket_ref,
                    parent_plan_id: p.parent_plan_id,
                    updated_at: p.updated_at,
                    total_phases: planPhases.length,
                    done_phases: planPhases.filter((ph) => ph.status === "done").length,
                    total_steps: planSteps.length,
                    done_steps: planSteps.filter((s) => s.status === "done").length,
                    current_phase_title: current?.title || null,
                };
            });

            let sessionQuery = supabase.from("agent_sessions").select("*").is("ended_at", null);
            if (repo_id) sessionQuery = sessionQuery.eq("repo_id", repo_id);
            const { data: sessionRows } = await sessionQuery;
            const sessions = ((sessionRows || []) as Session[]).filter(
                (s) => !isRepoExcluded(s.repo_id, requestExcludeRepos)
            );

            const now = Date.now();
            const out: string[] = [];
            out.push(repo_id ? `# 📦 Overview: ${repo_id}` : "# Overview: all repos");

            out.push("", "---", "## Plans");
            if (repo_id) {
                out.push(renderPlanTree(overviewRows, now));
            } else {
                const byRepo = new Map<string, PlanOverviewRow[]>();
                for (const p of overviewRows) {
                    if (!byRepo.has(p.repo_id)) byRepo.set(p.repo_id, []);
                    byRepo.get(p.repo_id)!.push(p);
                }
                if (byRepo.size) {
                    for (const [repo, rows] of byRepo) {
                        out.push("", `### 📦 ${repo}`, renderPlanTree(rows, now));
                    }
                } else {
                    out.push(renderPlanTree(overviewRows, now));
                }
            }

            out.push("", "---", "## Attention", renderAttentionSection(overviewRows, sessions, now));
            out.push("", "---", "## Active sessions", renderSessionTree(sessions, now));
            return ok(out.join("\n"));
        } catch (e) {
            return err(`overview error: ${(e as Error).message}`);
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
            plan_id: z.string().optional().describe("Explicit plan override for stateless callers"),
        },
    },
    async ({ note, mark_in_progress, plan_id }) => {
        try {
            const planId = await resolveActivePlanId(plan_id);
            if (!planId) return err("No active plan. Pass plan_id explicitly or call connect first.");
            const plan = await loadPlan(planId);
            if (!plan) return err("Active plan not found.");
            await supabase
                .from("plans")
                .update({ position_note: note, updated_at: new Date().toISOString() })
                .eq("id", planId);

            if (mark_in_progress) {
                const phaseId = await resolveCurrentPhaseId(planId, plan);
                if (phaseId) {
                    const { data: stepsData } = await supabase
                        .from("steps")
                        .select("*")
                        .eq("phase_id", phaseId)
                        .order("order_index", { ascending: true });
                    const resolved = resolveCursorStep(plan, phaseId, (stepsData || []) as Step[]);
                    if (resolved) {
                        await supabase.from("steps").update({ status: "in_progress" }).eq("id", resolved.stepId);
                        if (resolved.healed) {
                            await supabase
                                .from("plans")
                                .update({
                                    cursor_phase_id: phaseId,
                                    cursor_step_id: resolved.stepId,
                                    updated_at: new Date().toISOString(),
                                })
                                .eq("id", planId);
                        }
                    }
                }
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
            plan_id: z.string().optional().describe("Explicit plan override for stateless callers"),
        },
    },
    async ({ note, plan_id }) => {
        try {
            const planId = await resolveActivePlanId(plan_id);
            if (!planId) return err("No active plan. Pass plan_id explicitly or call connect first.");
            const plan = await loadPlan(planId);
            if (!plan) return err("Active plan not found.");

            const phaseId = await resolveCurrentPhaseId(planId, plan);
            if (!phaseId) return err("No current phase.");

            const { data: stepsData } = await supabase
                .from("steps")
                .select("*")
                .eq("phase_id", phaseId)
                .order("order_index", { ascending: true });
            const resolved = resolveCursorStep(plan, phaseId, (stepsData || []) as Step[]);
            if (!resolved) return err("No current step to complete.");

            await supabase
                .from("steps")
                .update({ status: "done", ...(note ? { progress_note: note } : {}) })
                .eq("id", resolved.stepId);

            // Find next todo step in the same phase
            const { data: steps } = await supabase
                .from("steps")
                .select("*")
                .eq("phase_id", phaseId)
                .order("order_index", { ascending: true });
            const next = ((steps || []) as Step[]).find((s) => s.status === "todo");

            if (next) {
                await supabase.from("steps").update({ status: "in_progress" }).eq("id", next.id);
                await supabase
                    .from("plans")
                    .update({ cursor_phase_id: phaseId, cursor_step_id: next.id, updated_at: new Date().toISOString() })
                    .eq("id", planId);
                return ok(`Step completed. Now on: ${next.title}`);
            } else {
                await supabase
                    .from("plans")
                    .update({ cursor_phase_id: phaseId, cursor_step_id: null, updated_at: new Date().toISOString() })
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
            plan_id: z.string().optional().describe("Explicit plan override for stateless callers"),
        },
    },
    async ({ confirm, plan_id }) => {
        try {
            const planId = await resolveActivePlanId(plan_id);
            if (!planId) return err("No active plan. Pass plan_id explicitly or call connect first.");
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
            const target = await resolveActivePlanId(plan_id);
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
            "Add a step to a phase. If the phase is the cursor phase of its plan and has no current step, this step becomes the cursor step.",
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

            // If this phase is its plan's cursor phase with no current step, adopt it.
            // Looked up via the phase's own plan_id, not the in-memory `active` var — a
            // stateless caller (or a cold function instance) must not lose cursor adoption.
            const { data: phaseRow } = await supabase.from("phases").select("plan_id").eq("id", phase_id).single();
            if (phaseRow) {
                // Atomic claim: only adopt the cursor if this phase is still the plan's
                // cursor phase AND no step has claimed the cursor yet. A plain
                // read-then-write here would race when multiple add_step calls run
                // concurrently (e.g. an agent batching independent tool calls) — two
                // calls could both read cursor_step_id as null and both "win". The
                // WHERE clause makes Postgres itself the arbiter: only one UPDATE can
                // match a still-null cursor_step_id row.
                const { data: claimed } = await supabase
                    .from("plans")
                    .update({ cursor_step_id: data.id, updated_at: new Date().toISOString() })
                    .eq("id", phaseRow.plan_id)
                    .eq("cursor_phase_id", phase_id)
                    .is("cursor_step_id", null)
                    .select("id");
                if (claimed && claimed.length) {
                    await supabase.from("steps").update({ status: "in_progress" }).eq("id", data.id);
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
            const target = repo || (await resolveActiveRepoId());
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
        inputSchema: {
            title: z.string(),
            body: z.string().optional(),
            repo_id: z.string().optional().describe("Explicit repo override for stateless callers"),
        },
    },
    async ({ title, body, repo_id }) => {
        try {
            const repoId = await requireActiveRepoId(repo_id);
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
        inputSchema: {
            repo_id: z.string().optional().describe("Explicit repo override for stateless callers"),
        },
    },
    async ({ repo_id }) => {
        try {
            const repoId = await requireActiveRepoId(repo_id);
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
            repo_id: z.string().optional().describe("Explicit repo override for stateless callers"),
        },
    },
    async ({ idea_id, branch, repo_id }) => {
        try {
            const repoId = await requireActiveRepoId(repo_id);
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
            await persistActive({ repoId, planId: plan.id });
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
            repo_id: z.string().optional().describe("Explicit repo override for stateless callers"),
        },
    },
    async ({ kind, title, body, scope, repo_id }) => {
        try {
            const repoId = scope === "global" ? null : await requireActiveRepoId(repo_id);
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
                args.repo_filter = await resolveActiveRepoId(); // includes globals too (RPC ORs null)
            } // 'all' → no repo filter, not only_global

            const { data, error } = await supabase.rpc("match_knowledge", args);
            if (error) return err(`search_knowledge error: ${error.message}`);
            const results = ((data || []) as Array<Record<string, unknown>>).filter(
                (k) => !isRepoExcluded(k.repo_id as string | null, requestExcludeRepos)
            );
            if (!results.length) return ok(`No knowledge found matching "${query}".`);

            const lines = results.map((k, i) => {
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
        "authorization, x-client-info, apikey, content-type, x-brain-key, x-access-key, x-exclude-repos, accept, mcp-session-id, mcp-protocol-version, last-event-id",
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

    requestExcludeRepos = parseExcludeRepos(c.req.header("x-exclude-repos"));

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

if (import.meta.main) {
    Deno.serve(app.fetch);
}

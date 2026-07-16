import { assertEquals } from "jsr:@std/assert";

Deno.env.set("SUPABASE_URL", "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");
Deno.env.set("OPENROUTER_API_KEY", "test-key");
Deno.env.set("MCP_ACCESS_KEY", "test-key");

const {
    shouldCreateInitialPlanningPhase,
    DEFAULT_INITIAL_PLANNING_PHASE_TITLE,
    DEFAULT_PLAN_KIND,
    buildInitialPlanningPhaseInsert,
    workingContractFor,
    isSessionStale,
    isPlanStale,
    formatHeartbeatAge,
    renderSessionTree,
    renderPlanTree,
    renderPlanLine,
    isSessionAttentionNeeded,
    isPlanAttentionNeeded,
    renderAttentionSection,
    SESSION_STALE_MS,
    normalizeJiraTicket,
    formatJiraSuffix,
    buildPlanInsert,
    jiraUrl,
    formatJiraLink,
    normalizeConfluenceDocs,
    formatConfluenceDocs,
    statusIcon,
    sessionKey,
    resolveActiveRepoId,
    resolveActivePlanId,
    parseExcludeRepos,
    isRepoExcluded,
    findCurrentStep,
    resolveCursorStep,
    buildDeletePlanPreview,
} = await import("./index.ts");

Deno.test("create_plan scaffolds planning phase by default", () => {
    assertEquals(shouldCreateInitialPlanningPhase(undefined), true);
});

Deno.test("create_plan can skip planning phase when caller already has a plan", () => {
    assertEquals(shouldCreateInitialPlanningPhase(false), false);
});

Deno.test("default initial phase title captures spec and planning work", () => {
    assertEquals(DEFAULT_INITIAL_PLANNING_PHASE_TITLE, "Spec and plan work");
});

Deno.test("initial planning phase is active first phase", () => {
    assertEquals(buildInitialPlanningPhaseInsert("plan-1"), {
        plan_id: "plan-1",
        title: "Spec and plan work",
        status: "active",
        order_index: 0,
    });
});

Deno.test("default plan kind is sprint", () => {
    assertEquals(DEFAULT_PLAN_KIND, "sprint");
});

Deno.test("sprint kind still scaffolds a planning phase by default", () => {
    assertEquals(shouldCreateInitialPlanningPhase(undefined, "sprint"), true);
});

Deno.test("spike/maintenance/investigation kinds skip the planning-phase scaffold by default", () => {
    assertEquals(shouldCreateInitialPlanningPhase(undefined, "spike"), false);
    assertEquals(shouldCreateInitialPlanningPhase(undefined, "maintenance"), false);
    assertEquals(shouldCreateInitialPlanningPhase(undefined, "investigation"), false);
});

Deno.test("explicit scaffold flag overrides the kind default either way", () => {
    assertEquals(shouldCreateInitialPlanningPhase(true, "spike"), true);
    assertEquals(shouldCreateInitialPlanningPhase(false, "sprint"), false);
});

// --- working contracts ---

Deno.test("working contract includes a kind-specific addendum", () => {
    const sprint = workingContractFor("sprint");
    const spike = workingContractFor("spike");
    const maintenance = workingContractFor("maintenance");
    const investigation = workingContractFor("investigation");
    assertEquals(sprint.includes("full engineering rigor"), true);
    assertEquals(spike.includes("quick-and-dirty") || spike.includes("prove the point"), true);
    assertEquals(maintenance.includes("parent_plan_id"), true);
    assertEquals(investigation.includes("don't assume code is the deliverable"), true);
    assertEquals(investigation.includes("stop and ask the user by name"), true);
});

Deno.test("working contract: missing kind behaves like the default kind (sprint)", () => {
    assertEquals(workingContractFor(undefined), workingContractFor("sprint"));
    assertEquals(workingContractFor(null), workingContractFor(DEFAULT_PLAN_KIND));
});

Deno.test("working contract: a genuinely unknown kind gets no addendum", () => {
    const unknown = workingContractFor("some-future-kind");
    assertEquals(unknown.includes("dev-context working contract"), true);
    assertEquals(unknown.includes("This is sprint work"), false);
    assertEquals(unknown.includes("This is a spike"), false);
    assertEquals(unknown.includes("This is a maintenance loop"), false);
    assertEquals(unknown.includes("This is an investigation"), false);
});

// --- staleness ---

Deno.test("isSessionStale flags heartbeats older than the threshold", () => {
    const now = 1_000_000_000_000;
    const fresh = new Date(now - 1000).toISOString();
    const stale = new Date(now - SESSION_STALE_MS - 1).toISOString();
    assertEquals(isSessionStale(fresh, now), false);
    assertEquals(isSessionStale(stale, now), true);
});

Deno.test("isPlanStale flags plans not updated within staleDays", () => {
    const now = 1_000_000_000_000;
    const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    assertEquals(isPlanStale(recent, now, 7), false);
    assertEquals(isPlanStale(old, now, 7), true);
});

Deno.test("formatHeartbeatAge renders human-friendly buckets", () => {
    const now = 1_000_000_000_000;
    assertEquals(formatHeartbeatAge(new Date(now - 5_000).toISOString(), now), "just now");
    assertEquals(formatHeartbeatAge(new Date(now - 5 * 60_000).toISOString(), now), "5m ago");
    assertEquals(formatHeartbeatAge(new Date(now - 3 * 3600_000).toISOString(), now), "3h ago");
    assertEquals(formatHeartbeatAge(new Date(now - 2 * 86_400_000).toISOString(), now), "2d ago");
});

// --- session tree ---

function session(overrides: Record<string, unknown>) {
    return {
        id: "s1",
        repo_id: "r",
        plan_id: null,
        parent_session_id: null,
        session_ref: "workspace:1",
        source: "cmux",
        host: "h",
        role: "worker",
        title: "",
        status: "running",
        activity: "",
        started_at: new Date(0).toISOString(),
        last_heartbeat_at: new Date(0).toISOString(),
        ended_at: null,
        ...overrides,
    };
}

Deno.test("renderSessionTree reports no sessions", () => {
    assertEquals(renderSessionTree([], 0), "(no sessions)");
});

Deno.test("renderSessionTree nests children under their parent, in order", () => {
    const now = 0;
    const parent = session({ id: "p1", role: "orchestrator", title: "orchestrator" });
    const child = session({ id: "c1", parent_session_id: "p1", title: "worker-1" });
    const out = renderSessionTree([parent, child], now);
    const lines = out.split("\n");
    assertEquals(lines.length, 2);
    assertEquals(lines[0].includes("orchestrator/orchestrator"), true);
    assertEquals(lines[1].startsWith("  -"), true);
    assertEquals(lines[1].includes("worker/worker-1"), true);
});

Deno.test("renderSessionTree treats a dangling parent ref as a root instead of dropping it", () => {
    const orphan = session({ id: "c1", parent_session_id: "missing-parent" });
    const out = renderSessionTree([orphan], 0);
    assertEquals(out.split("\n").length, 1);
});

Deno.test("renderSessionTree flags a running session with a stale heartbeat", () => {
    const now = 1_000_000_000_000;
    const stale = session({ status: "running", last_heartbeat_at: new Date(now - SESSION_STALE_MS - 1).toISOString() });
    const out = renderSessionTree([stale], now);
    assertEquals(out.includes("⚠ stale"), true);
});

// --- plan overview / attention ---

function planRow(overrides: Record<string, unknown>) {
    return {
        id: "pl1",
        repo_id: "r",
        title: "Plan",
        kind: "sprint",
        status: "active",
        ticket_ref: null,
        parent_plan_id: null,
        updated_at: new Date(0).toISOString(),
        total_phases: 2,
        done_phases: 1,
        total_steps: 4,
        done_steps: 2,
        current_phase_title: "Build",
        ...overrides,
    };
}

Deno.test("isPlanAttentionNeeded flags blocked and paused plans", () => {
    assertEquals(isPlanAttentionNeeded(planRow({ status: "blocked" }), 0).flag, true);
    assertEquals(isPlanAttentionNeeded(planRow({ status: "paused" }), 0).flag, true);
    assertEquals(isPlanAttentionNeeded(planRow({ status: "active" }), 0).flag, false);
});

Deno.test("isPlanAttentionNeeded flags a stale active plan", () => {
    const now = 1_000_000_000_000;
    const stale = planRow({ status: "active", updated_at: new Date(now - 8 * 86_400_000).toISOString() });
    const result = isPlanAttentionNeeded(stale, now, 7);
    assertEquals(result.flag, true);
    assertEquals(result.reason?.includes("stale"), true);
});

Deno.test("renderPlanLine shows kind, status, ticket, and step progress", () => {
    const line = renderPlanLine(planRow({ ticket_ref: "JIRA-1" }));
    assertEquals(line.includes("[sprint]"), true);
    assertEquals(line.includes("JIRA-1"), true);
    assertEquals(line.includes("50% steps done"), true);
    assertEquals(line.includes("phase 1/2"), true);
});

Deno.test("renderPlanTree nests a maintenance loop's spawned fix plans under it", () => {
    const parent = planRow({ id: "loop", title: "Maintenance loop", kind: "maintenance" });
    const child = planRow({ id: "fix1", parent_plan_id: "loop", title: "Fix flaky test" });
    const out = renderPlanTree([parent, child], 0);
    const lines = out.split("\n");
    assertEquals(lines.length, 2);
    assertEquals(lines[1].startsWith(`  ${statusIcon("active")} [`), true);
});

Deno.test("renderAttentionSection reports nothing when all is well", () => {
    const out = renderAttentionSection([planRow({})], [session({})], 0);
    assertEquals(out, "Nothing needs attention.");
});

Deno.test("renderAttentionSection surfaces blocked plans and stuck sessions", () => {
    const now = 1_000_000_000_000;
    const blocked = planRow({ status: "blocked", title: "Blocked plan" });
    const stuck = session({ status: "waiting_input", title: "waiter" });
    const out = renderAttentionSection([blocked], [stuck], now);
    assertEquals(out.includes("Blocked plan"), true);
    assertEquals(out.includes("waiter"), true);
    assertEquals(isSessionAttentionNeeded(stuck, now).reason, "waiting on input");
});

// --- jira ticket ---

Deno.test("create_plan with a jira ticket stores it on the insert payload", () => {
    assertEquals(
        buildPlanInsert({ repoId: "repo-1", title: "Plan A", jiraTicket: "NOC-2359" }).jira_ticket,
        "NOC-2359"
    );
});

Deno.test("create_plan without a jira ticket stores null", () => {
    assertEquals(buildPlanInsert({ repoId: "repo-1", title: "Plan A" }).jira_ticket, null);
});

Deno.test("update_jira_ticket sets a new ticket reference", () => {
    assertEquals(normalizeJiraTicket("NOC-2359"), "NOC-2359");
});

Deno.test("update_jira_ticket clears the ticket reference on empty input", () => {
    assertEquals(normalizeJiraTicket(""), null);
    assertEquals(normalizeJiraTicket(undefined), null);
    assertEquals(normalizeJiraTicket(null), null);
});

Deno.test("formatJiraSuffix renders a parenthetical when set", () => {
    assertEquals(formatJiraSuffix("NOC-2359"), " (Jira: NOC-2359)");
});

Deno.test("formatJiraSuffix is empty when unset", () => {
    assertEquals(formatJiraSuffix(null), "");
    assertEquals(formatJiraSuffix(undefined), "");
});

// --- jira link resolution ---

Deno.test("jiraUrl is null when there is no ticket", () => {
    assertEquals(jiraUrl(null, "https://co.atlassian.net"), null);
    assertEquals(jiraUrl(undefined, "https://co.atlassian.net"), null);
});

Deno.test("jiraUrl resolves a bare key against the configured site", () => {
    assertEquals(jiraUrl("NOC-2359", "https://co.atlassian.net"), "https://co.atlassian.net/browse/NOC-2359");
});

Deno.test("jiraUrl strips a trailing slash from the site URL", () => {
    assertEquals(jiraUrl("NOC-2359", "https://co.atlassian.net/"), "https://co.atlassian.net/browse/NOC-2359");
});

Deno.test("jiraUrl is null for a bare key when no site is configured", () => {
    assertEquals(jiraUrl("NOC-2359", ""), null);
    assertEquals(jiraUrl("NOC-2359", undefined), null);
});

Deno.test("jiraUrl passes a full URL through as-is, site or not", () => {
    assertEquals(jiraUrl("https://co.atlassian.net/browse/NOC-2359", ""), "https://co.atlassian.net/browse/NOC-2359");
    assertEquals(
        jiraUrl("http://co.atlassian.net/browse/NOC-2359", "https://other.atlassian.net"),
        "http://co.atlassian.net/browse/NOC-2359"
    );
});

Deno.test("formatJiraLink renders a markdown link when a URL resolves", () => {
    assertEquals(formatJiraLink("NOC-2359", "https://co.atlassian.net"), "[NOC-2359](https://co.atlassian.net/browse/NOC-2359)");
});

Deno.test("formatJiraLink falls back to plain text when no URL resolves", () => {
    assertEquals(formatJiraLink("NOC-2359", ""), "NOC-2359");
});

Deno.test("formatJiraLink is empty when unset", () => {
    assertEquals(formatJiraLink(null, "https://co.atlassian.net"), "");
    assertEquals(formatJiraLink(undefined, "https://co.atlassian.net"), "");
});

// --- confluence docs ---

Deno.test("normalizeConfluenceDocs drops entries without a url and trims strings", () => {
    assertEquals(
        normalizeConfluenceDocs([
            { url: " https://co.atlassian.net/wiki/x ", title: " Spec " },
            { url: "" } as { url: string },
            { title: "no url" } as unknown as { url: string },
        ]),
        [{ url: "https://co.atlassian.net/wiki/x", title: "Spec" }]
    );
});

Deno.test("normalizeConfluenceDocs is an empty array when unset", () => {
    assertEquals(normalizeConfluenceDocs(null), []);
    assertEquals(normalizeConfluenceDocs(undefined), []);
});

Deno.test("formatConfluenceDocs renders one markdown bullet per doc", () => {
    assertEquals(
        formatConfluenceDocs([
            { url: "https://co.atlassian.net/wiki/x", title: "Spec" },
            { url: "https://co.atlassian.net/wiki/y" },
        ]),
        ["- [Spec](https://co.atlassian.net/wiki/x)", "- [https://co.atlassian.net/wiki/y](https://co.atlassian.net/wiki/y)"]
    );
});

Deno.test("formatConfluenceDocs is empty when no docs are attached", () => {
    assertEquals(formatConfluenceDocs([]), []);
    assertEquals(formatConfluenceDocs(undefined), []);
});

Deno.test("create_plan with confluence docs stores them normalized on the insert payload", () => {
    assertEquals(
        buildPlanInsert({
            repoId: "repo-1",
            title: "Plan A",
            confluenceDocs: [{ url: "https://co.atlassian.net/wiki/x" }],
        }).confluence_docs,
        [{ url: "https://co.atlassian.net/wiki/x" }]
    );
});

Deno.test("create_plan without confluence docs defaults to an empty array", () => {
    assertEquals(buildPlanInsert({ repoId: "repo-1", title: "Plan A" }).confluence_docs, []);
});

// --- status icon ---

Deno.test("statusIcon maps known statuses to a glanceable symbol", () => {
    assertEquals(statusIcon("active"), "🟢");
    assertEquals(statusIcon("running"), "🟢");
    assertEquals(statusIcon("done"), "✅");
    assertEquals(statusIcon("blocked"), "🔴");
    assertEquals(statusIcon("failed"), "❌");
    assertEquals(statusIcon("paused"), "⏸️");
    assertEquals(statusIcon("waiting_input"), "⏳");
    assertEquals(statusIcon("idle"), "💤");
    assertEquals(statusIcon("todo"), "⬜");
});

Deno.test("statusIcon falls back to a dot for unknown statuses", () => {
    assertEquals(statusIcon("some-future-status"), "•");
});

// --- active context resolution ---

Deno.test("sessionKey falls back to a singleton default without a session_ref", () => {
    assertEquals(sessionKey(), "__default__");
    assertEquals(sessionKey(null, null), "__default__");
    assertEquals(sessionKey("host-a", null), "__default__");
});

Deno.test("sessionKey combines host and session_ref into a stable composite key", () => {
    assertEquals(sessionKey(null, "workspace:1"), "\0workspace:1");
    assertEquals(sessionKey("host-a", "workspace:1"), "host-a\0workspace:1");
});

Deno.test("resolveActiveRepoId returns an explicit override and caches it for later calls", async () => {
    assertEquals(await resolveActiveRepoId("repo-explicit"), "repo-explicit");
    assertEquals(await resolveActiveRepoId(), "repo-explicit");
});

Deno.test("resolveActivePlanId returns an explicit override without caching it (unlike repo id)", async () => {
    assertEquals(await resolveActivePlanId("plan-explicit"), "plan-explicit");
    // No session_ref/DB row for this fake backend, so the follow-up call
    // falls through the (empty) warm cache to a DB miss rather than
    // echoing back the prior explicit override.
    assertEquals(await resolveActivePlanId(), null);
});

Deno.test("parseExcludeRepos returns an empty list when the header is absent", () => {
    assertEquals(parseExcludeRepos(undefined), []);
    assertEquals(parseExcludeRepos(null), []);
    assertEquals(parseExcludeRepos(""), []);
});

Deno.test("parseExcludeRepos splits, trims, and drops empty entries", () => {
    assertEquals(parseExcludeRepos("kenese/eat-thing"), ["kenese/eat-thing"]);
    assertEquals(parseExcludeRepos("kenese/eat-thing, kenese/other ,,"), [
        "kenese/eat-thing",
        "kenese/other",
    ]);
});

Deno.test("isRepoExcluded matches an excluded repo_id exactly", () => {
    assertEquals(isRepoExcluded("kenese/eat-thing", ["kenese/eat-thing"]), true);
    assertEquals(isRepoExcluded("kenese/code-brain", ["kenese/eat-thing"]), false);
});

Deno.test("isRepoExcluded never excludes global (null repo_id) knowledge", () => {
    assertEquals(isRepoExcluded(null, ["kenese/eat-thing"]), false);
});

Deno.test("isRepoExcluded is false when no exclusions are configured", () => {
    assertEquals(isRepoExcluded("kenese/eat-thing", []), false);
});

// --- findCurrentStep / resolveCursorStep (cursor self-healing) ---

function step(id: string, order_index: number, status: string) {
    return { id, phase_id: "phase-1", title: id, detail: "", progress_note: null, status, order_index };
}

Deno.test("findCurrentStep returns null for an empty phase", () => {
    assertEquals(findCurrentStep([]), null);
});

Deno.test("findCurrentStep returns null when every step is done", () => {
    const steps = [step("s1", 0, "done"), step("s2", 1, "done")];
    assertEquals(findCurrentStep(steps), null);
});

Deno.test("findCurrentStep picks the first not-done step by order_index, regardless of input order", () => {
    const steps = [step("s3", 2, "todo"), step("s1", 0, "todo"), step("s2", 1, "todo")];
    assertEquals(findCurrentStep(steps)?.id, "s1");
});

Deno.test("findCurrentStep prefers an in_progress step over an earlier todo step", () => {
    const steps = [step("s1", 0, "todo"), step("s2", 1, "in_progress"), step("s3", 2, "todo")];
    assertEquals(findCurrentStep(steps)?.id, "s2");
});

Deno.test("findCurrentStep skips done steps to find the next todo one", () => {
    const steps = [step("s1", 0, "done"), step("s2", 1, "done"), step("s3", 2, "todo")];
    assertEquals(findCurrentStep(steps)?.id, "s3");
});

Deno.test("resolveCursorStep: freshly created plan with no cursor set resolves to the first todo step and reports healed", () => {
    const plan = { cursor_phase_id: "phase-1", cursor_step_id: null };
    const steps = [step("s1", 0, "todo"), step("s2", 1, "todo"), step("s3", 2, "todo")];
    const resolved = resolveCursorStep(plan, "phase-1", steps);
    assertEquals(resolved, { stepId: "s1", healed: true });
});

Deno.test("resolveCursorStep: an explicitly-set, still-open cursor step is trusted as-is (not healed)", () => {
    const plan = { cursor_phase_id: "phase-1", cursor_step_id: "s2" };
    const steps = [step("s1", 0, "todo"), step("s2", 1, "in_progress"), step("s3", 2, "todo")];
    const resolved = resolveCursorStep(plan, "phase-1", steps);
    assertEquals(resolved, { stepId: "s2", healed: false });
});

Deno.test("resolveCursorStep: heals when the stored cursor step has gone stale (already done)", () => {
    const plan = { cursor_phase_id: "phase-1", cursor_step_id: "s1" };
    const steps = [step("s1", 0, "done"), step("s2", 1, "todo"), step("s3", 2, "todo")];
    const resolved = resolveCursorStep(plan, "phase-1", steps);
    assertEquals(resolved, { stepId: "s2", healed: true });
});

Deno.test("resolveCursorStep: heals when the cursor points at a different phase than the one being resolved", () => {
    // e.g. plan.cursor_phase_id still references a prior phase, but the caller
    // is resolving against the phase that's actually active in the DB.
    const plan = { cursor_phase_id: "phase-0", cursor_step_id: "s0" };
    const steps = [step("s1", 0, "todo"), step("s2", 1, "todo")];
    const resolved = resolveCursorStep(plan, "phase-1", steps);
    assertEquals(resolved, { stepId: "s1", healed: true });
});

Deno.test("resolveCursorStep: returns null when the resolved phase has no open steps left", () => {
    const plan = { cursor_phase_id: "phase-1", cursor_step_id: null };
    const steps = [step("s1", 0, "done"), step("s2", 1, "done")];
    assertEquals(resolveCursorStep(plan, "phase-1", steps), null);
});

Deno.test("resolveCursorStep: an explicit plan_id is resolved independently of a different implicit active plan", async () => {
    // Mirrors the reported repro: the session/warm-cache may consider a
    // different plan "active" (or none at all), but a caller passing plan_id
    // explicitly must still resolve cleanly against that plan's own steps.
    const implicitActive = await resolveActivePlanId("plan-implicit");
    assertEquals(implicitActive, "plan-implicit");

    const explicitPlan = { cursor_phase_id: "phase-1", cursor_step_id: null };
    const explicitSteps = [step("s1", 0, "todo"), step("s2", 1, "todo")];
    const resolvedForExplicitPlan = resolveCursorStep(explicitPlan, "phase-1", explicitSteps);
    assertEquals(resolvedForExplicitPlan, { stepId: "s1", healed: true });

    // resolveActivePlanId itself: passing a different plan_id explicitly wins
    // over whatever was previously resolved, and does not get cached over it.
    assertEquals(await resolveActivePlanId("plan-explicit-2"), "plan-explicit-2");
});

// --- delete_plan preview ---

Deno.test("buildDeletePlanPreview: bare plan with no phases/children/sessions", () => {
    const preview = buildDeletePlanPreview(
        { title: "Fix flaky test", status: "active" },
        { phases: 0, childPlans: 0, sessions: 0 }
    );
    assertEquals(
        preview,
        [
            'About to permanently delete plan "Fix flaky test" (status: active).',
            "0 phase(s) and their steps will be deleted along with it.",
            "This cannot be undone. Confirm with the user, then call delete_plan(plan_id, confirm=true).",
        ].join("\n")
    );
});

Deno.test("buildDeletePlanPreview: reports phase count and omits child/session lines when zero", () => {
    const preview = buildDeletePlanPreview(
        { title: "Migrate auth", status: "active" },
        { phases: 3, childPlans: 0, sessions: 0 }
    );
    assertEquals(preview.includes("3 phase(s) and their steps will be deleted along with it."), true);
    assertEquals(preview.includes("child plan"), false);
    assertEquals(preview.includes("agent session"), false);
});

Deno.test("buildDeletePlanPreview: surfaces child plans as orphaned, not deleted", () => {
    const preview = buildDeletePlanPreview(
        { title: "Maintenance loop", status: "active" },
        { phases: 1, childPlans: 2, sessions: 0 }
    );
    assertEquals(preview.includes("2 child plan(s) (linked via parent_plan_id) will be orphaned, not deleted."), true);
});

Deno.test("buildDeletePlanPreview: surfaces sessions whose plan_id will be cleared", () => {
    const preview = buildDeletePlanPreview(
        { title: "Sprint work", status: "active" },
        { phases: 1, childPlans: 0, sessions: 1 }
    );
    assertEquals(preview.includes("1 agent session(s) referencing this plan will have their plan_id cleared."), true);
});

Deno.test("buildDeletePlanPreview: always ends with the explicit confirm instruction", () => {
    const preview = buildDeletePlanPreview({ title: "Anything", status: "done" }, { phases: 0, childPlans: 0, sessions: 0 });
    assertEquals(preview.endsWith("Confirm with the user, then call delete_plan(plan_id, confirm=true)."), true);
});

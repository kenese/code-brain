import { assertEquals } from "jsr:@std/assert";

Deno.env.set("SUPABASE_URL", "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");
Deno.env.set("OPENROUTER_API_KEY", "test-key");
Deno.env.set("MCP_ACCESS_KEY", "test-key");

const {
    shouldCreateInitialPlanningPhase,
    DEFAULT_INITIAL_PLANNING_PHASE_TITLE,
    buildInitialPlanningPhaseInsert,
    normalizeJiraTicket,
    formatJiraSuffix,
    buildPlanInsert,
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

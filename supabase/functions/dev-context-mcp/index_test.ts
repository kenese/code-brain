import { assertEquals } from "jsr:@std/assert";

Deno.env.set("SUPABASE_URL", "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");
Deno.env.set("OPENROUTER_API_KEY", "test-key");
Deno.env.set("MCP_ACCESS_KEY", "test-key");

const {
    shouldCreateInitialPlanningPhase,
    DEFAULT_INITIAL_PLANNING_PHASE_TITLE,
    buildInitialPlanningPhaseInsert,
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

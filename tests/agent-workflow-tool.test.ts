import test from "node:test";
import assert from "node:assert/strict";
import agentWorkflowExtension from "../extensions/agent_workflow/index.js";

test("agent_workflow extension registers the agent_workflow tool", () => {
  let registeredTool: { name: string; label: string } | undefined;

  agentWorkflowExtension({
    registerTool(definition: { name: string; label: string }) {
      registeredTool = {
        name: definition.name,
        label: definition.label,
      };
    },
  } as never);

  assert.deepEqual(registeredTool, {
    name: "agent_workflow",
    label: "Agent Workflow",
  });
});


test("parallel task schema admits at most eight tasks", () => {
  let tool: { parameters: { properties: { tasks: { maxItems?: number } } } };
  agentWorkflowExtension({ registerTool(value: typeof tool) { tool = value; } } as never);
  assert.equal(tool!.parameters.properties.tasks.maxItems, 8);
});

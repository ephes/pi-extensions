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

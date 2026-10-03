/**
 * The WebAssembly entry point. The SDK calls `main()` itself and reports a rejection, so nothing
 * here calls it.
 */

import { Runner } from "@chainlink/cre-sdk";

import { configSchema, type WorkflowConfig } from "../src/config.js";
import { initWorkflow } from "./workflow.js";

export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig, unknown>({ configSchema });
  await runner.run(initWorkflow);
}

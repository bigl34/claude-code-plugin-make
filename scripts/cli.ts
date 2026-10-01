#!/usr/bin/env npx tsx

import { z, createCommand, runCli, buildSafeOutput, wrapUntrustedField } from "@local/cli-utils";
import { realpathSync } from "fs";
import { pathToFileURL } from "url";
import { MakeMCPClient } from "./mcp-client.js";
import { MakeRestClient, isNotionWriteModule, type ScenarioBlueprint, type ScenarioSummary } from "./make-rest.js";

const BLUEPRINT_POOL_SIZE = 4;

interface EnrichedScenario extends ScenarioSummary {
  trigger: string;
  touchesNotion: boolean;
  notionTargets: ScenarioBlueprint["notionTargets"];
}

export function parseExecuteParams(paramsJson: string | undefined): Record<string, unknown> | undefined {
  if (paramsJson === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(paramsJson);
  } catch {
    throw new Error("--params must be valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--params must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export const commands = {
  "list-scenarios": createCommand(
    z.object({}),
    async () => {
      const restClient = new MakeRestClient();
      const scenarios = await restClient.listScenarios();
      const enriched = await enrichScenarios(restClient, scenarios);
      const active = enriched.filter((scenario) => scenario.isActive).length;
      const notionWriters = enriched.filter((scenario) =>
        scenario.notionTargets.some((target) => isNotionWriteModule(target.module)),
      ).length;

      return buildSafeOutput(
        { total: enriched.length, active, notionWriters },
        {
          scenarios: enriched.map((scenario) => ({
            id: scenario.id,
            name: wrapUntrustedField("name", scenario.name),
            isActive: scenario.isActive,
            isPaused: scenario.isPaused,
            scheduling: scenario.scheduling,
            trigger: scenario.trigger,
            touchesNotion: scenario.touchesNotion,
            notionTargets: scenario.notionTargets,
          })),
        },
      );
    },
    "List all Make.com scenarios via REST (id, name, active, scheduling, Notion targets)",
    { sideEffect: "read" }
  ),

  "scenario-health": createCommand(
    z.object({
      id: z.string().optional().describe("Scenario id; omit for all"),
    }),
    async (args) => {
      const { id } = args as { id?: string };
      const restClient = new MakeRestClient();
      const scenarios = id
        ? [await restClient.getScenario(id)]
        : await restClient.listScenarios();
      const enriched = await enrichScenarios(restClient, scenarios);
      const active = enriched.filter((scenario) => scenario.isActive).length;
      const inactive = enriched.length - active;
      const withDlq = enriched.filter((scenario) => (scenario.dlqCount ?? 0) > 0).length;

      return buildSafeOutput(
        { checked: enriched.length, active, inactive, withDlq },
        {
          scenarios: enriched.map((scenario) => ({
            id: scenario.id,
            name: wrapUntrustedField("name", scenario.name),
            isActive: scenario.isActive,
            isPaused: scenario.isPaused,
            dlqCount: scenario.dlqCount,
            lastEdit: scenario.lastEdit,
            scheduling: scenario.scheduling,
            touchesNotion: scenario.touchesNotion,
            notionTargets: scenario.notionTargets,
          })),
        },
      );
    },
    "Health of one or all scenarios: isActive, dlqCount, lastEdit, scheduling, Notion targets",
    { sideEffect: "read" }
  ),

  "list-tools": createCommand(
    z.object({}),
    async (_args, client: MakeMCPClient) => {
      const tools = await client.listTools();
      if (tools.length === 0) {
        return {
          message: "No On-Demand scenarios found. Configure scenarios with 'On-Demand' scheduling in Make.com to make them available here.",
          tools: [],
        };
      }
      return tools.map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    "List all available On-Demand scenarios",
    { sideEffect: "read" }
  ),

  "execute": createCommand(
    z.object({
      tool: z.string().min(1).describe("Tool/scenario name to execute"),
      params: z.string().optional().describe("JSON parameters to pass to the scenario"),
    }),
    async (args, client: MakeMCPClient) => {
      const { tool, params: paramsJson } = args as { tool: string; params?: string };
      const params = parseExecuteParams(paramsJson);
      return client.executeScenario(tool, params);
    },
    "Execute an On-Demand scenario",
    { sideEffect: "external_send" }
  ),
};

async function enrichScenarios(
  restClient: MakeRestClient,
  scenarios: ScenarioSummary[],
): Promise<EnrichedScenario[]> {
  return mapWithConcurrency(scenarios, BLUEPRINT_POOL_SIZE, async (scenario) => {
    const blueprint = await restClient.getBlueprint(scenario.id);

    return {
      ...scenario,
      trigger: blueprint.triggerApp,
      touchesNotion: blueprint.touchesNotion,
      notionTargets: blueprint.notionTargets,
    };
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const workerCount = Math.min(limit, items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      const item = items[index];
      nextIndex += 1;
      results[index] = await mapper(item, index);
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker());

  await Promise.all(workers);

  return results;
}

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, MakeMCPClient, {
    programName: "make-cli",
    description: "Make.com On-Demand scenario execution",
    cleanup: async (client: MakeMCPClient) => client.disconnect(),
  });
}


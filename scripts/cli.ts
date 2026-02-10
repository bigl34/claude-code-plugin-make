#!/usr/bin/env npx tsx
/**
 * Make.com MCP CLI
 *
 * Zod-validated CLI for executing On-Demand Make.com scenarios.
 */

import { z, createCommand, runCli } from "@local/cli-utils";
import { MakeMCPClient } from "./mcp-client.js";

// Define commands with Zod schemas
const commands = {
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
    "List all available On-Demand scenarios"
  ),

  "execute": createCommand(
    z.object({
      tool: z.string().min(1).describe("Tool/scenario name to execute"),
      params: z.string().optional().describe("JSON parameters to pass to the scenario"),
    }),
    async (args, client: MakeMCPClient) => {
      const { tool, params: paramsJson } = args as { tool: string; params?: string };
      let params: Record<string, unknown> | undefined;
      if (paramsJson) {
        try {
          params = JSON.parse(paramsJson);
        } catch {
          throw new Error("--params must be valid JSON");
        }
      }
      return client.executeScenario(tool, params);
    },
    "Execute an On-Demand scenario"
  ),
};

// Run CLI with cleanup
runCli(commands, MakeMCPClient, {
  programName: "make-cli",
  description: "Make.com On-Demand scenario execution",
  cleanup: async (client: MakeMCPClient) => client.disconnect(),
});

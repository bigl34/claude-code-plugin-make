/**
 * Make.com MCP Client
 *
 * MCP wrapper client for executing Make.com scenarios.
 * Connects to the Make MCP server via stdio transport.
 *
 * Key features:
 * - List available On-Demand scenarios as tools
 * - Execute scenarios with optional parameters
 * - Handle scenario responses and errors
 *
 * Note: Only On-Demand scheduled scenarios are exposed.
 * Scenarios with other triggers (webhook, polling, etc.) are not available.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MCPConfig {
  mcpServer: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

interface Tool {
  name: string;
  description?: string;
  inputSchema?: any;
}

export class MakeMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, "..", "config.json");
    this.config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  // ============================================
  // CONNECTION MANAGEMENT
  // ============================================

  /** Establishes connection to the Make MCP server. Auto-connects if needed. */
  async connect(): Promise<void> {
    if (this.connected) return;

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    this.transport = new StdioClientTransport({
      command: this.config.mcpServer.command,
      args: this.config.mcpServer.args,
      env: env as Record<string, string>,
    });

    this.client = new Client(
      { name: "make-cli", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** Closes the MCP server connection. */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  // ============================================
  // SCENARIO OPERATIONS
  // ============================================

  /**
   * Lists all available tools (On-Demand scenarios).
   *
   * The Make.com MCP server only exposes On-Demand scenarios as tools.
   * If no On-Demand scenarios are configured, this returns an empty array.
   */
  async listTools(): Promise<Tool[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  /**
   * Execute an On-Demand scenario by its tool name
   *
   * @param toolName - The name of the tool (scenario) to execute
   * @param params - Optional parameters to pass to the scenario
   */
  async executeScenario(toolName: string, params?: Record<string, any>): Promise<any> {
    await this.connect();

    const result = await this.client!.callTool({
      name: toolName,
      arguments: params || {},
    });
    const content = result.content as Array<{ type: string; text?: string }>;

    if (result.isError) {
      const errorContent = content.find((c) => c.type === "text");
      throw new Error(errorContent?.text || "Tool call failed");
    }

    const textContent = content.find((c) => c.type === "text");
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }

    return content;
  }
}

export default MakeMCPClient;

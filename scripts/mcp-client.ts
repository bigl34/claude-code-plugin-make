
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadServiceConfig, z } from "@local/cli-utils";

const MakeMcpConfigSchema = z.object({
  mcpServer: z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
  }),
});

type MCPConfig = z.infer<typeof MakeMcpConfigSchema>;

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
    this.config = loadServiceConfig("make-scenario-manager", {
      schema: MakeMcpConfigSchema,
    });
  }


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

    try {
      await this.client.connect(this.transport);
    } catch (error) {
      throw this.describeConnectFailure(error);
    }
    this.connected = true;
  }

  private describeConnectFailure(error: unknown): Error {
    const cause = error as { code?: string; message?: string } | null | undefined;
    const isMissingBinary =
      cause?.code === "ENOENT" || /\bENOENT\b/.test(cause?.message ?? "");

    if (!isMissingBinary) {
      return error instanceof Error ? error : new Error(String(error));
    }

    const command = this.config.mcpServer.command;
    return new Error(
      `Make MCP server '${command}' could not be started (ENOENT): the binary is not on PATH. ` +
        `No request reached Make, so this says nothing about your scenarios. ` +
        `The REST commands do not need this binary — use 'list-scenarios' or 'scenario-health' ` +
        `for read-only scenario inspection. The MCP path is only needed to run On-Demand ` +
        `scenarios, and would only ever expose those.`,
      { cause: error }
    );
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }


  async listTools(): Promise<Tool[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

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

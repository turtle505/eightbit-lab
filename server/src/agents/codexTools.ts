import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface CodexToolSpec {
  type: 'namespace';
  name: string;
  description: string;
  tools: { type: 'function'; name: string; description: string; inputSchema: unknown }[];
}

/** Reuse the exact MCP tools already provided to Claude, over an in-process MCP link. */
export class CodexTools {
  specs: CodexToolSpec[] = [];
  private clients = new Map<string, Client>();
  private servers: McpServer[] = [];

  async add(name: string, server: McpServer) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'eightbit-lab-codex', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    this.clients.set(name, client);
    this.servers.push(server);
    this.specs.push({
      type: 'namespace', name, description: `${name} tools from 8-bit Lab`,
      tools: listed.tools.map((t) => ({ type: 'function', name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema })),
    });
  }

  async call(namespace: string, tool: string, args: Record<string, unknown>) {
    const client = this.clients.get(namespace);
    if (!client) throw new Error(`Unknown office tool namespace: ${namespace}`);
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return {
      contentItems: content.filter((c) => c.type === 'text').map((c) => ({ type: 'inputText', text: c.text ?? '' })),
      success: !result.isError,
    };
  }

  async close() {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    await Promise.all(this.servers.map((s) => s.close()));
  }
}

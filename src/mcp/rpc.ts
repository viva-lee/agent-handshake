// Just enough MCP (JSON-RPC 2.0) for a tools server: initialize, ping, tools/list and tools/call.
import { TOOLS, type Counter } from './counter.ts';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'counter-protocol', title: 'Counter Protocol (sandbox)', version: '0.1.0' };

const INSTRUCTIONS =
  'Counter Protocol lets an agent book a business through an API instead of a phone call. ' +
  'Flow: find_business (by phone number) → check_availability → confirm with the user → book. ' +
  'Bookings come back with a receipt signed by the business; keep it. ' +
  'This server runs a sandbox with two demo shops: +1-602-555-0123 (Phoenix) and +82-2-555-0123 (Seoul). Nothing real is booked.';

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Id = string | number | null;

export interface RpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

const failure = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Handles one incoming message. Returns the response, or undefined for notifications and stray responses. */
export async function handle(msg: unknown, counter: Counter): Promise<RpcResponse | undefined> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return failure(null, -32600, 'Invalid Request');
  const { id, method, params } = msg as { id?: Id; method?: unknown; params?: Record<string, unknown> };
  if (typeof method !== 'string') return id === undefined ? failure(null, -32600, 'Invalid Request') : undefined;
  if (id === undefined) return undefined; // notifications (initialized, cancelled, …) need no answer
  try {
    return { jsonrpc: '2.0', id, result: await dispatch(method, params ?? {}, counter) };
  } catch (e) {
    return e instanceof RpcError ? failure(id, e.code, e.message) : failure(id, -32603, e instanceof Error ? e.message : String(e));
  }
}

async function dispatch(method: string, params: Record<string, unknown>, counter: Counter): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const wanted = String(params.protocolVersion ?? '');
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = String(params.name ?? '');
      if (!TOOLS.some((t) => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await counter.call(name, args), null, 2) }] };
      } catch (e) {
        // Tool failures go back to the model as results it can read and recover from.
        return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

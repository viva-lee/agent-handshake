// `npm run mcp` → Counter Protocol as an MCP server on stdio, for Claude Code, Claude Desktop, Cursor and other MCP clients.
// A registry and two demo shops run in-process, so there is nothing to host. stdout carries only protocol messages.
import { createInterface } from 'node:readline';
import { Counter } from './counter.ts';
import { handle } from './rpc.ts';
import { startSandbox } from './sandbox.ts';

const sandbox = await startSandbox();
const counter = new Counter(sandbox.registry, sandbox.operator);
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);

createInterface({ input: process.stdin })
  .on('line', async (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => handle(m, counter)))).filter(Boolean);
      if (out.length) send(out);
    } else {
      const out = await handle(msg, counter);
      if (out) send(out);
    }
  })
  .on('close', async () => {
    await sandbox.close();
    process.exit(0);
  });

console.error(`counter-mcp: sandbox ready (${sandbox.shops.map((s) => `${s.name} ${s.tel}`).join(', ')})`);

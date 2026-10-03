import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { demoFixture } from '../src/demo/fixtures.ts';

test('MCP server over stdio: find a shop, book it, verify the receipt, cancel', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
  });
  let next = 0;
  const write = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const rpc = (method: string, params?: object) =>
    new Promise<any>((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      write({ id, method, params });
    });
  const tool = async (name: string, args: object) => {
    const { result } = await rpc('tools/call', { name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    write({ method: 'notifications/initialized' });

    const { result: list } = await rpc('tools/list');
    assert.deepEqual(
      list.tools.map((t: { name: string }) => t.name),
      ['find_business', 'check_availability', 'book', 'cancel_booking', 'verify_receipt'],
    );

    const shop = await tool('find_business', { tel: '+1 (602) 555-0123' });
    assert.equal(shop.name, 'Desert Bloom Salon');
    assert.equal(shop.session_trust, 'operator-verified');

    const { request } = demoFixture('en');
    const avail = await tool('check_availability', { business_id: shop.business_id, service: "Women's cut", date: request.date, after: '12:00', before: '18:00' });
    assert.match(avail.slots[0].start, /T14:00:00-07:00$/); // the seeded bookings fill the early afternoon
    assert.equal(avail.slots[0].staff, 'Kim');

    const booked = await tool('book', { business_id: shop.business_id, slot_id: avail.slots[0].slot_id, customer_name: 'Alex Rivera' });
    assert.equal(booked.status, 'confirmed');
    assert.equal(booked.receipt.verified, true);
    assert.equal(booked.receipt.booking_id, booked.booking_id);

    assert.equal((await tool('verify_receipt', { receipt: booked.receipt.jws })).verified, true);
    const [h, p, sig] = booked.receipt.jws.split('.');
    const forged = `${h}.${p}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    assert.equal((await tool('verify_receipt', { receipt: forged })).verified, false);

    const cancelled = await tool('cancel_booking', { business_id: shop.business_id, booking_id: booked.booking_id });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.receipt.action, 'cancelled');

    const again = await rpc('tools/call', { name: 'book', arguments: { business_id: shop.business_id, slot_id: avail.slots[0].slot_id } });
    assert.equal(again.result.isError, true); // missing customer_name comes back as a tool error the model can read
    assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    assert.equal((await rpc('resources/list')).error.code, -32601);
  } finally {
    child.kill();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../test-support/app-server.mjs';

test('internal resumes exclude history while explicit overrides and raw calls win', async t => {
  const f = await fixture(t);
  for (const args of [['wait', 'demo'], ['adopt', 'thread-1'], ['resume', 'demo', '--thread-params', '{"excludeTurns":false}'], ['call', 'thread/resume', '{"threadId":"thread-1"}', '--port', String(f.port)]]) {
    const before = f.received.length;
    const result = await f.command(args);
    assert.equal(result.code, 0, result.stderr);
    const params = f.received.slice(before).find(m => m.method === 'thread/resume').params;
    assert.equal(params.excludeTurns, args[0] === 'call' ? undefined : args.includes('--thread-params') ? false : true);
  }
});

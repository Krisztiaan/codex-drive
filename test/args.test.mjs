import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseArgs } from '../src/args.mjs';

const start = ['start', '--cwd', '.', '--model', 'gpt-6.1-sol', '--effort', 'low', '--log', 'events.jsonl'];

test('start uses explicit inputs and safe sandbox/approval defaults', () => {
  const result = parseArgs([...start, 'Do the work']);
  assert.equal(result.command, 'start');
  assert.deepEqual(result.positional, ['Do the work']);
  assert.deepEqual(result.options, {
    cwd: resolve('.'), model: 'gpt-6.1-sol', effort: 'low', log: resolve('events.jsonl'),
    sandbox: 'workspace-write', approval: 'on-request',
  });
});

test('--cd alias and repeated --add-dir resolve paths', () => {
  const result = parseArgs(['start', '--cd', 'project', '--model', 'gpt-6.1-sol', '--effort', 'low',
    '--log', 'events.jsonl', '--add-dir', 'first', '--add-dir', 'second', '--name', 'demo-1', 'Go']);
  assert.equal(result.options.cwd, resolve('project'));
  assert.deepEqual(result.options['add-dir'], [resolve('first'), resolve('second')]);
  assert.equal(result.options.name, 'demo-1');
  assert.throws(() => parseArgs([...start, '--cd', '.', 'Go']), /Choose --cwd or --cd/);
});

test('full access and approval never must be explicit', () => {
  const result = parseArgs([...start, '--sandbox', 'danger-full-access', '--approval', 'never', 'Go']);
  assert.equal(result.options.sandbox, 'danger-full-access');
  assert.equal(result.options.approval, 'never');
  assert.throws(() => parseArgs([...start, '--sandbox', 'danger-full-access', '--add-dir', '.', 'Go']), /--add-dir requires workspace-write/);
});

test('all commands parse their positional arguments and supported flags', () => {
  for (const [argv, expected] of [
    [['serve'], []], [['serve', '--stop', '--port', '4701'], []],
    [['steer', 'demo', '--turn', 'turn-1', 'Stop now'], ['demo', 'Stop now']],
    [['interrupt', 'demo', '--port', '4701'], ['demo']],
    [['status'], []], [['status', 'demo'], ['demo']],
    [['tail', 'demo', '-n', '20'], ['demo']],
    [['resume', 'demo', 'Continue'], ['demo', 'Continue']],
  ]) {
    assert.deepEqual(parseArgs(argv).positional, expected);
  }
  assert.equal(parseArgs(['serve', '--stop']).options.stop, true);
  assert.equal(parseArgs(['tail', 'demo', '--n', '3']).options.n, '3');
});

test('-- preserves prompt text starting with dashes', () => {
  assert.deepEqual(parseArgs([...start, '--', '--please finish']).positional, ['--please finish']);
});

test('invalid command options, duplicate flags, missing values, and counts fail clearly', () => {
  for (const argv of [[], ['unknown'], ['status', '--stop'], ['tail', 'demo', '-x'],
    ['serve', '--port'], ['serve', '--port', '--stop'], ['serve', '--port', '4700', '--port', '4701'],
    ['serve', 'extra'], ['steer', 'demo'], ['interrupt'], ['status', 'one', 'two'],
    ['tail'], [...start, ''], [...start, 'one', 'two']]) {
    assert.throws(() => parseArgs(argv), Error, JSON.stringify(argv));
  }
});

test('server configuration can supply model and effort; start defaults cwd and safety', () => {
  const result = parseArgs(['start', 'Go']);
  assert.deepEqual(result.options, { cwd: resolve('.'), sandbox: 'workspace-write', approval: 'on-request' });
  assert.deepEqual(parseArgs(['resume', 'demo']).positional, ['demo']);
});

test('ports and tail count have numeric bounds', () => {
  for (const port of ['0', '65536', '-1', '4.5', 'abc']) {
    assert.throws(() => parseArgs(['serve', '--port', port]), /Port must be/);
  }
  for (const port of ['1', '65535']) assert.equal(parseArgs(['serve', '--port', port]).options.port, port);
  for (const count of ['0', '-1', '1.5', 'abc']) {
    assert.throws(() => parseArgs(['tail', 'demo', '-n', count]), /positive integer/);
  }
});

test('invalid sandbox, approval policy, and unsafe names are rejected', () => {
  assert.throws(() => parseArgs([...start, '--sandbox', 'unsafe', 'Go']), /Invalid sandbox/);
  assert.throws(() => parseArgs([...start, '--approval', 'always', 'Go']), /Invalid approval policy/);
  for (const name of ['../escape', '/absolute', '.', '..', 'space name', 'nested/name']) {
    assert.throws(() => parseArgs([...start, '--name', name, 'Go']), /Invalid thread name/);
  }
});

test('wait supports fractional positive timeouts and start/resume accept detach', () => {
  assert.equal(parseArgs(['wait', 'demo', '--timeout', '0.25']).options.timeout, '0.25');
  for (const value of ['-1', '0', 'NaN', 'Infinity', 'abc', '9999999999']) {
    assert.throws(() => parseArgs(['wait', 'demo', '--timeout', value]), /--timeout/);
  }
  assert.equal(parseArgs([...start, '--detach', 'Go']).options.detach, true);
  assert.equal(parseArgs(['resume', 'demo', '--detach', 'Go']).options.detach, true);
});

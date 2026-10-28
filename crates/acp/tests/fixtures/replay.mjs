// Replays a recorded-shape ACP agent script. Product code never starts this fixture.
//
// Usage: node replay.mjs <script.ndjson> [--record=<file>]
// Each script line answers one incoming method, in order (the last line for a
// method is reused once the others are consumed):
//   {"on": "session/prompt", "before": [steps], "result": {...} | "error": {...}, "after": [steps]}
// Steps: {"update": {...}} sends session/update (sessionId from the step, the
// request, or the last session/new result), {"sleep": ms}, {"request":
// {"method", "params"}} waits for the client's answer, {"hold": true} leaves a
// prompt unanswered until a `session/cancel` line answers it, {"notify":
// {"method", "params"}} sends any other notification as is.
// Every incoming message is appended to the --record file as one JSON line.
import fs from 'node:fs';
import readline from 'node:readline';

const script = process.argv[2];
const record = process.argv.find(arg => arg.startsWith('--record='))?.slice(9);
const lines = fs.readFileSync(script, 'utf8').split('\n').filter(line => line.trim() && !line.trim().startsWith('//')).map(line => JSON.parse(line));
const used = new Map();
let sequence = 1000;
let lastSession = 'session-1';
const held = new Map();
const callbacks = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (method, params) => new Promise(resolve => {
  const id = sequence++;
  callbacks.set(id, resolve);
  send({ id, method, params });
});

function entry(method) {
  const all = lines.filter(line => line.on === method);
  if (!all.length) return undefined;
  const index = used.get(method) ?? 0;
  used.set(method, index + 1);
  return all[Math.min(index, all.length - 1)];
}

async function run(steps, message) {
  for (const step of steps ?? []) {
    if (step.sleep) await sleep(step.sleep);
    if (step.notify) send({ method: step.notify.method, params: step.notify.params });
    if (step.update) send({ method: 'session/update', params: { sessionId: step.sessionId ?? message.params?.sessionId ?? lastSession, update: step.update } });
    if (step.request) await call(step.request.method, { sessionId: message.params?.sessionId ?? lastSession, ...step.request.params });
    if (step.hold) return true;
  }
  return false;
}

function respond(message, line) {
  if (line.error) send({ id: message.id, error: line.error });
  else send({ id: message.id, result: line.result ?? {} });
  if (message.method === 'session/new' && line.result?.sessionId) lastSession = line.result.sessionId;
}

async function handle(message) {
  let line = entry(message.method);
  if (message.method === 'initialize' && !line) line = { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
  if (message.method === 'session/cancel') {
    const prompt = held.get(message.params.sessionId);
    if (!prompt) return;
    if (line?.sleep) await sleep(line.sleep);
    held.delete(message.params.sessionId);
    send({ id: prompt.id, result: line?.result ?? { stopReason: 'cancelled' } });
    return;
  }
  if (message.id === undefined) return;
  if (!line) { send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }); return; }
  if (await run(line.before, message)) { held.set(message.params.sessionId, message); return; }
  respond(message, line);
  await run(line.after, message);
}

readline.createInterface({ input: process.stdin }).on('line', text => {
  const message = JSON.parse(text);
  if (record) fs.appendFileSync(record, JSON.stringify(message) + '\n');
  if (!message.method) {
    const callback = callbacks.get(message.id);
    callbacks.delete(message.id);
    callback?.(message.result ?? message.error);
    return;
  }
  handle(message).catch(error => { console.error(error); process.exit(9); });
});

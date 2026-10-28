// Deterministic ACP peer for span-agents delegation tests. Product code never
// starts this fixture. The first line of a prompt selects the behaviour:
//   work:<ticks>:<ms>   tick <ticks> times every <ms> ms with thoughts and usage, then end_turn
//   usage:<n>           report <n> context tokens, then wait for Stop
//   write:<path>:<text> write <text> to <path> through fs/write_text_file (editor review)
//   permission          ask for permission; rejected ends the turn cancelled
//   reply:<text>        answer <text>
//   refuse | limit      stop with refusal | max_tokens
//   wait                wait for Stop
//   stubborn            never finish and ignore session/cancel for this session
//   servers             answer with the JSON mcpServers this session received in session/new
//   mcp <url> <token> <json>  act as a lead: POST <json> to the MCP server, answer with the body
// Flags: --name=<n>, --mcp-http, --mcp-sse, --image, --reject-session (session/new fails).
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
const flag = name => process.argv.includes(name);
const agentName = process.argv.find(arg => arg.startsWith('--name='))?.slice(7) ?? 'span-worker';
let cwd = '';
let sessions = 0;
let sequence = 500;
const active = new Map();
const servers = new Map();
const stubborn = new Set();
const callbacks = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const finish = (sessionId, id, stopReason) => {
  if (active.get(sessionId) !== id) return;
  active.delete(sessionId);
  send({ id, result: { stopReason } });
};
const call = (method, params) => new Promise((resolve, reject) => {
  const id = sequence++;
  callbacks.set(id, { resolve, reject });
  send({ id, method, params });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function lead(sessionId, id, text) {
  const [, url, token, ...rest] = text.split(' ');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' },
    body: rest.join(' '),
  });
  say(sessionId, await response.text());
  finish(sessionId, id, 'end_turn');
}

async function prompt(message) {
  const { sessionId, prompt } = message.params;
  const id = message.id;
  const text = prompt.find(block => block.type === 'text')?.text ?? '';
  const first = text.split('\n')[0];
  active.set(sessionId, id);
  if (first.startsWith('mcp ')) return lead(sessionId, id, first);
  if (first === 'wait') return;
  if (first === 'stubborn') { stubborn.add(sessionId); return; }
  if (first === 'servers') { say(sessionId, JSON.stringify(servers.get(sessionId) ?? null)); return finish(sessionId, id, 'end_turn'); }
  if (first === 'refuse') return finish(sessionId, id, 'refusal');
  if (first === 'limit') return finish(sessionId, id, 'max_tokens');
  if (first.startsWith('reply:')) { say(sessionId, first.slice(6)); return finish(sessionId, id, 'end_turn'); }
  if (first.startsWith('usage:')) {
    update(sessionId, { sessionUpdate: 'usage_update', used: Number(first.slice(6)), size: 200000 });
    return;
  }
  if (first.startsWith('work:')) {
    const [, ticks, ms] = first.split(':').map(Number);
    for (let i = 0; i < ticks; i++) {
      await sleep(ms);
      if (active.get(sessionId) !== id) return;
      update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `tick ${i}` } });
      if (i % 30 === 0) update(sessionId, { sessionUpdate: 'usage_update', used: 100 * (i + 1), size: 200000 });
    }
    say(sessionId, `${agentName} worked ${ticks} ticks`);
    return finish(sessionId, id, 'end_turn');
  }
  if (first.startsWith('write:')) {
    const [, path, ...content] = first.split(':');
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'write-1', title: `Write ${path}`, kind: 'edit', status: 'pending' });
    try {
      await call('fs/write_text_file', { sessionId, path: `${cwd}/${path}`, content: content.join(':') + '\n' });
      say(sessionId, `wrote ${path}`);
      return finish(sessionId, id, 'end_turn');
    } catch {
      return finish(sessionId, id, 'cancelled');
    }
  }
  if (first === 'permission') {
    const answer = await call('session/request_permission', {
      sessionId, toolCall: { toolCallId: 'run-1', title: 'Run deploy script', kind: 'execute' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    });
    if (answer.outcome.outcome !== 'selected' || answer.outcome.optionId === 'no') return finish(sessionId, id, 'cancelled');
    say(sessionId, 'allowed');
    return finish(sessionId, id, 'end_turn');
  }
  say(sessionId, text);
  finish(sessionId, id, 'end_turn');
}

input.on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    const callback = callbacks.get(message.id); callbacks.delete(message.id);
    if (callback) message.error ? callback.reject(message.error) : callback.resolve(message.result);
    return;
  }
  if (message.method === 'initialize') {
    const agentCapabilities = {
      promptCapabilities: { image: flag('--image') },
      mcpCapabilities: { http: flag('--mcp-http'), sse: flag('--mcp-sse') },
    };
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities, authMethods: [], agentInfo: { name: agentName, version: '1.0.0' } } });
  } else if (message.method === 'session/new') {
    if (flag('--reject-session')) return send({ id: message.id, error: { code: -32603, message: 'session refused by fixture' } });
    cwd = message.params.cwd;
    const sessionId = `${agentName}-${++sessions}`;
    servers.set(sessionId, message.params.mcpServers ?? null);
    send({ id: message.id, result: { sessionId } });
  } else if (message.method === 'session/close') {
    send({ id: message.id, result: {} });
  } else if (message.method === 'session/prompt') {
    prompt(message).catch(error => { console.error(error); process.exit(9); });
  } else if (message.method === 'session/cancel') {
    const sessionId = message.params.sessionId;
    if (stubborn.has(sessionId)) return;
    if (active.has(sessionId)) finish(sessionId, active.get(sessionId), 'cancelled');
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});

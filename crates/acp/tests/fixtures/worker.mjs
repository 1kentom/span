// Deterministic ACP peer for span-agents delegation tests. Product code never
// starts this fixture. The first line of a prompt selects the behaviour:
//   work:<ticks>:<ms>   tick <ticks> times every <ms> ms with thoughts and usage, then end_turn
//   usage:<n>           report a 30000 token baseline, then <n> more context tokens, then wait for Stop
//   spend:<n>           report the baseline, then <n> more, then answer and end_turn
//   late:<n>            report the baseline, answer and end_turn, then report <n> more
//   write:<path>:<text> write <text> to <path> through fs/write_text_file (editor review)
//   permission          ask for permission; rejected ends the turn cancelled
//   reply:<text>        answer <text>
//   refuse | limit      stop with refusal | max_tokens
//   wait                wait for Stop
//   stubborn            never finish and ignore session/cancel for this session
//   servers             answer with the JSON mcpServers this session received in session/new
//   mcp <url> <token> <json>  act as a lead: POST <json> to the MCP server, answer with the body
//   ended               answer with the JSON list of session ids closed or deleted so far
//   prompts             answer with the number of prompts received so far
//   created             answer with the number of sessions created with session/new so far
//   health-prompts      answer with the JSON list of session ids that received a health check prompt
//   forget              forget every other session: prompting one fails with "Session not found"
//   requests            answer with the JSON list of session/new, session/set_config_option and
//                       session/prompt requests so far, as "method sessionId [configId=value]"
// Flags: --name=<n>, --mcp-http, --mcp-sse, --image, --reject-session (session/new fails),
//   --auth-required (session/new answers -32000 Authentication required),
//   --close, --delete, --list (advertise and answer session/close, session/delete, session/list;
//   listed sessions are titled with their first prompt), --silent-health (never answer the
//   Span health check prompt), --slow-health=<ms> (answer it after <ms>),
//   --permission-health (ask for permission before answering it), --keep-closed (closed and
//   deleted sessions stay listed, as real agents keep them), --seed-health=<n> (list <n>
//   health sessions of an earlier run, titled "Health check. Reply with exactly one word..."),
//   --seed-chats (list user chats whose titles nearly match the health check prompt),
//   --models (session/new lists model, mode and effort config options; session/set_config_option
//   changes them and answers with the full list).
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
const titles = new Map();
const ended = [];
let prompts = 0;
const forgotten = new Set();
const healthPrompts = [];
const requests = [];
const configs = new Map();
const MODELS = [['fast-1', 'Fast One'], ['claude-haiku-4-5', 'Claude Haiku 4.5'], ['deep-2', 'Deep Two']];
const configOptions = c => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: c.model, options: MODELS.map(([value, name]) => ({ value, name })) },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: c.mode, options: [{ value: 'default', name: 'Ask' }, { value: 'acceptEdits', name: 'Accept edits' }, { value: 'plan', name: 'Plan' }, { value: 'bypassPermissions', name: 'Bypass permissions' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: c.effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
const seedHealth = Number(process.argv.find(arg => arg.startsWith('--seed-health='))?.slice(14) ?? 0);
for (let i = 1; i <= seedHealth; i++) titles.set(`old-health-${i}`, 'Health check. Reply with exactly one word...');
if (flag('--seed-chats')) {
  titles.set('chat-ci', 'Health check of the CI pipeline');
  titles.set('chat-two', 'Health check. Reply with exactly two words: ALL GOOD');
  titles.set('chat-build', 'Fix the build');
}
const slowHealth = Number(process.argv.find(arg => arg.startsWith('--slow-health='))?.slice(14) ?? 0);
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
// Context a fresh agent session holds before any task: system prompt and tools.
const BASELINE = 30000;
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
  if (forgotten.has(sessionId)) return send({ id, error: { code: -32602, message: 'Session not found' } });
  active.set(sessionId, id);
  prompts++;
  if (!titles.get(sessionId)) titles.set(sessionId, first);
  if (first.startsWith('Health check')) {
    healthPrompts.push(sessionId);
    if (flag('--silent-health')) return;
    if (flag('--permission-health')) {
      const answer = await call('session/request_permission', {
        sessionId, toolCall: { toolCallId: 'health-1', title: 'Read a file', kind: 'read' },
        options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      });
      if (answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'yes') { console.error('health permission allowed'); process.exit(7); }
    }
    if (slowHealth) await sleep(slowHealth);
    say(sessionId, 'OK');
    return finish(sessionId, id, 'end_turn');
  }
  if (first === 'ended') { say(sessionId, JSON.stringify(ended)); return finish(sessionId, id, 'end_turn'); }
  if (first === 'created') { say(sessionId, String(sessions)); return finish(sessionId, id, 'end_turn'); }
  if (first === 'health-prompts') { say(sessionId, JSON.stringify(healthPrompts)); return finish(sessionId, id, 'end_turn'); }
  if (first === 'forget') {
    for (const known of titles.keys()) if (known !== sessionId) forgotten.add(known);
    say(sessionId, 'forgot'); return finish(sessionId, id, 'end_turn');
  }
  if (first === 'requests') { say(sessionId, JSON.stringify(requests)); return finish(sessionId, id, 'end_turn'); }
  if (first === 'prompts') { say(sessionId, String(prompts)); return finish(sessionId, id, 'end_turn'); }
  if (first.startsWith('mcp ')) return lead(sessionId, id, first);
  if (first === 'wait') return;
  if (first === 'stubborn') { stubborn.add(sessionId); return; }
  if (first === 'servers') { say(sessionId, JSON.stringify(servers.get(sessionId) ?? null)); return finish(sessionId, id, 'end_turn'); }
  if (first === 'refuse') return finish(sessionId, id, 'refusal');
  if (first === 'limit') return finish(sessionId, id, 'max_tokens');
  if (first.startsWith('reply:')) { say(sessionId, first.slice(6)); return finish(sessionId, id, 'end_turn'); }
  if (first.startsWith('usage:')) {
    update(sessionId, { sessionUpdate: 'usage_update', used: BASELINE, size: 200000 });
    update(sessionId, { sessionUpdate: 'usage_update', used: BASELINE + Number(first.slice(6)), size: 200000 });
    return;
  }
  if (first.startsWith('spend:')) {
    update(sessionId, { sessionUpdate: 'usage_update', used: BASELINE, size: 200000 });
    update(sessionId, { sessionUpdate: 'usage_update', used: BASELINE + Number(first.slice(6)), size: 200000 });
    say(sessionId, 'spent');
    return finish(sessionId, id, 'end_turn');
  }
  if (first.startsWith('late:')) {
    update(sessionId, { sessionUpdate: 'usage_update', used: BASELINE, size: 200000 });
    say(sessionId, 'answered');
    finish(sessionId, id, 'end_turn');
    update(sessionId, { sessionUpdate: 'usage_update', used: BASELINE + Number(first.slice(5)), size: 200000 });
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
    const sessionCapabilities = {};
    if (flag('--close')) sessionCapabilities.close = {};
    if (flag('--delete')) sessionCapabilities.delete = {};
    if (flag('--list')) sessionCapabilities.list = {};
    if (Object.keys(sessionCapabilities).length) agentCapabilities.sessionCapabilities = sessionCapabilities;
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities, authMethods: [], agentInfo: { name: agentName, version: '1.0.0' } } });
  } else if (message.method === 'session/new') {
    if (flag('--auth-required')) return send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
    if (flag('--reject-session')) return send({ id: message.id, error: { code: -32603, message: 'session refused by fixture' } });
    cwd = message.params.cwd;
    const sessionId = `${agentName}-${++sessions}`;
    servers.set(sessionId, message.params.mcpServers ?? null);
    titles.set(sessionId, '');
    requests.push(`session/new ${sessionId}`);
    if (!flag('--models')) return send({ id: message.id, result: { sessionId } });
    configs.set(sessionId, { model: 'fast-1', mode: 'default', effort: 'low' });
    send({ id: message.id, result: { sessionId, configOptions: configOptions(configs.get(sessionId)) } });
  } else if (message.method === 'session/set_config_option' && flag('--models')) {
    const { sessionId, configId, value } = message.params;
    requests.push(`session/set_config_option ${sessionId} ${configId}=${value}`);
    const config = configs.get(sessionId);
    if (!config || !(configId in config)) return send({ id: message.id, error: { code: -32602, message: 'Unknown config option' } });
    config[configId] = value;
    send({ id: message.id, result: { configOptions: configOptions(config) } });
  } else if (message.method === 'session/close' || (message.method === 'session/delete' && flag('--delete'))) {
    ended.push(message.params.sessionId);
    forgotten.add(message.params.sessionId);
    if (!flag('--keep-closed')) titles.delete(message.params.sessionId);
    send({ id: message.id, result: {} });
  } else if (message.method === 'session/list' && flag('--list')) {
    const listed = [...titles.keys()].map(sessionId => ({ sessionId, cwd, title: titles.get(sessionId) || null }));
    send({ id: message.id, result: { sessions: listed } });
  } else if (message.method === 'session/prompt') {
    requests.push(`session/prompt ${message.params.sessionId}`);
    prompt(message).catch(error => { console.error(error); process.exit(9); });
  } else if (message.method === 'session/cancel') {
    const sessionId = message.params.sessionId;
    if (stubborn.has(sessionId)) return;
    if (active.has(sessionId)) finish(sessionId, active.get(sessionId), 'cancelled');
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});

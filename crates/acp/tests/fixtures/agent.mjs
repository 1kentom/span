// Deterministic ACP test peer. Product code never starts this fixture.
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
let cwd = '';
let sequence = 100;
let sessions = 0;
const modelConfig = value => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value, options: [{ value: 'fast', name: 'Fast' }, { value: 'deep', name: 'Deep' }] }];
// Active prompt request id and Stop handling are tracked per session so one
// process can run turns in several sessions at once.
const activePrompts = new Map();
const stubborn = new Set();
let authenticated = false;
const rich = process.argv.includes('--rich');
const needsAuth = process.argv.includes('--auth');
const agentName = process.argv.find(arg => arg.startsWith('--name='))?.slice(7) ?? 'span-test-peer';
const callbacks = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => {
  for (const [session, active] of activePrompts) if (active === id) activePrompts.delete(session);
  send({ id, result: value });
};
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const call = (method, params) => new Promise((resolve, reject) => {
  const id = sequence++;
  callbacks.set(id, { resolve, reject });
  send({ id, method, params });
});
async function prompt(message) {
  const { sessionId, prompt } = message.params;
  const text = prompt.find(block => block.type === 'text')?.text ?? '';
  activePrompts.set(sessionId, message.id);
  if (text === 'stubborn') stubborn.add(sessionId); else stubborn.delete(sessionId);
  if (text === 'crash') { console.error('fixture process failure'); process.exit(7); }
  if (text === 'truncated') { process.stdout.write('{"jsonrpc":"2.0","id":'); process.exit(0); }
  if (text === 'wait' || text === 'stubborn') return;
  if (text.startsWith('stream:')) {
    // Interleaves with other sessions: each chunk names the agent and session.
    for (let i = 0; i < Number(text.slice(7)); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (!activePrompts.has(sessionId)) return;
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${agentName}:${sessionId}:${i}` } });
    }
    result(message.id, { stopReason: 'end_turn' }); return;
  }
  if (text.startsWith('stop:')) { result(message.id, { stopReason: text.slice(5) }); return; }
  if (text === 'echo' || text.startsWith('/') || prompt.some(block => block.type !== 'text')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(prompt) } });
    result(message.id, { stopReason: 'end_turn' }); return;
  }
  if (text.startsWith('elicit-')) {
    const scope = { sessionId };
    const answer = text === 'elicit-form'
      ? await call('elicitation/create', { ...scope, mode: 'form', message: 'Pick a name', requestedSchema: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name'] } })
      : await call('elicitation/create', { ...scope, mode: 'url', elicitationId: 'e-1', message: 'Sign in', url: text === 'elicit-badurl' ? 'javascript:alert(1)' : 'https://example.com/auth' });
    if (text === 'elicit-url') send({ method: 'elicitation/complete', params: { elicitationId: 'e-1' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(answer) } });
    result(message.id, { stopReason: 'end_turn' }); return;
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking buffer' } });
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Review edit', priority: 'high', status: 'in_progress' }] });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit sample', kind: 'edit', status: 'pending' });
  const read = await call('fs/read_text_file', { sessionId, path: `${cwd}/sample.txt` });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Read: ${read.content}` } });
  const permission = await call('session/request_permission', {
    sessionId, toolCall: { toolCallId: 'edit-1', title: 'Edit sample', kind: 'edit', rawInput: { path: 'sample.txt' } },
    options: [ { optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Allow this tool in this session', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' } ]
  });
  if (permission.outcome.outcome !== 'selected' || permission.outcome.optionId === 'no') {
    result(message.id, { stopReason: 'cancelled' }); return;
  }
  try {
    await call('fs/write_text_file', { sessionId, path: `${cwd}/sample.txt`, content: text === 'same' ? read.content : text === 'multi' ? 'ONE\nkeep\nTHREE\n' : 'agent proposal\n' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed' });
    result(message.id, { stopReason: 'end_turn' });
  } catch {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'failed' });
    result(message.id, { stopReason: 'cancelled' });
  }
}
input.on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    const callback = callbacks.get(message.id); callbacks.delete(message.id);
    if (callback) message.error ? callback.reject(message.error) : callback.resolve(message.result);
    return;
  }
  if (message.method === 'initialize') {
    const fs = message.params.clientCapabilities.fs;
    if (!fs.readTextFile || !fs.writeTextFile || message.params.clientCapabilities.terminal) process.exit(8);
    const client = message.params.clientCapabilities;
    if (rich && !(client.session?.notices && client.session?.compaction && client.elicitation?.form && client.elicitation?.url)) process.exit(8);
    let agentCapabilities = process.argv.includes('--resume') ? { loadSession: true, sessionCapabilities: { list: {} } } : {};
    if (rich) agentCapabilities = { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } };
    const extra = {};
    if (process.argv.includes('--close') || process.argv.includes('--close-gone')) extra.close = {};
    if (process.argv.includes('--delete')) extra.delete = {};
    if (Object.keys(extra).length) agentCapabilities = { ...agentCapabilities, sessionCapabilities: { list: {}, ...(agentCapabilities.sessionCapabilities ?? {}), ...extra } };
    const authMethods = needsAuth ? [{ id: 'token', name: 'Token', description: 'API token' }, { type: 'terminal', id: 'tui', name: 'Terminal login', args: ['login'] }] : [];
    result(message.id, { protocolVersion: 1, agentCapabilities, authMethods, agentInfo: { name: agentName, title: 'Span Test Peer', version: '1.0.0' } });
  } else if (message.method === 'authenticate') {
    if (message.params.methodId === 'token') { authenticated = true; result(message.id, {}); }
    else send({ id: message.id, error: { code: -32602, message: 'Unknown method' } });
  } else if (message.method === 'session/new') {
    if (process.argv.includes('--missing-session')) { send({ id: message.id, error: { code: -32601, message: 'Method not found: session/new' } }); return; }
    if (process.argv.includes('--hang-session')) return;
    if (needsAuth && !authenticated) { send({ id: message.id, error: { code: -32000, message: 'Sign in required' } }); return; }
    cwd = message.params.cwd;
    const sessionId = `fixture-${++sessions}`;
    result(message.id, { sessionId, ...(process.argv.includes('--config') ? { configOptions: modelConfig('fast') } : {}) });
    if (rich) {
      update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'web', description: 'Search the web', input: { hint: 'query' } }, { name: 'plan', description: 'Plan' }] });
      update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'architect' });
      update(sessionId, { sessionUpdate: 'session_info_update', title: 'Renamed chat', updatedAt: '2026-10-28T10:00:00Z' });
      update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.25, currency: 'USD' } });
      update(sessionId, { sessionUpdate: 'notice', severity: 'warning', title: 'MCP server unavailable', description: 'docs offline' });
      update(sessionId, { sessionUpdate: 'compaction_update', compactionId: 'c-1', status: 'in_progress' });
      update(sessionId, { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c-1', content: { type: 'text', text: 'Summary part' } });
      update(sessionId, { sessionUpdate: 'compaction_update', compactionId: 'c-1', status: 'completed' });
    }
  } else if (message.method === 'session/set_config_option') {
    result(message.id, { configOptions: modelConfig(message.params.value) });
  } else if (message.method === 'session/list') {
    result(message.id, { sessions: [{ sessionId: 'old-1', cwd, title: 'Earlier chat', updatedAt: '2026-10-28T09:00:00Z' }] });
  } else if (message.method === 'session/load') {
    const sessionId = message.params.sessionId;
    update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'sub-1', title: 'Read file', kind: 'read', status: 'completed', _meta: { claudeCode: { parentToolUseId: 'task-1' } } });
    result(message.id, {});
  } else if (message.method === 'session/close') {
    if (process.argv.includes('--close-gone')) send({ id: message.id, error: { code: -32002, message: 'Session not found' } });
    else result(message.id, {});
  } else if (message.method === 'session/delete') {
    if (activePrompts.has(message.params.sessionId)) send({ id: message.id, error: { code: -32603, message: 'delete arrived while a prompt was active' } });
    else result(message.id, {});
  } else if (message.method === 'session/prompt') {
    if (process.argv.includes('--missing-prompt')) { send({ id: message.id, error: { code: -32601, message: 'Method not found: session/prompt' } }); return; }
    prompt(message).catch(error => { console.error(error); process.exit(9); });
  } else if (message.method === 'session/cancel') {
    const sessionId = message.params.sessionId;
    if (activePrompts.has(sessionId) && !stubborn.has(sessionId)) result(activePrompts.get(sessionId), { stopReason: 'cancelled' });
  }
});

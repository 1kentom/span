// Deterministic ACP test peer. Product code never starts this fixture.
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
let cwd = '';
let sequence = 100;
let sessions = 0;
let activePrompt;
let ignoreCancel = false;
const modelConfig = value => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value, options: [{ value: 'fast', name: 'Fast' }, { value: 'deep', name: 'Deep' }] }];
const callbacks = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const call = (method, params) => new Promise((resolve, reject) => {
  const id = sequence++;
  callbacks.set(id, { resolve, reject });
  send({ id, method, params });
});
async function prompt(message) {
  const { sessionId, prompt } = message.params;
  const text = prompt[0].text;
  activePrompt = message.id;
  ignoreCancel = text === 'stubborn';
  if (text === 'crash') { console.error('fixture process failure'); process.exit(7); }
  if (text === 'truncated') { process.stdout.write('{"jsonrpc":"2.0","id":'); process.exit(0); }
  if (text === 'wait' || text === 'stubborn') return;
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
    const agentCapabilities = process.argv.includes('--resume') ? { loadSession: true, sessionCapabilities: { list: {} } } : {};
    result(message.id, { protocolVersion: 1, agentCapabilities, agentInfo: { name: 'span-test-peer', version: '1.0.0' } });
  } else if (message.method === 'session/new') {
    if (process.argv.includes('--missing-session')) { send({ id: message.id, error: { code: -32601, message: 'Method not found: session/new' } }); return; }
    if (process.argv.includes('--hang-session')) return;
    cwd = message.params.cwd;
    result(message.id, { sessionId: `fixture-${++sessions}`, ...(process.argv.includes('--config') ? { configOptions: modelConfig('fast') } : {}) });
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
  } else if (message.method === 'session/prompt') {
    if (process.argv.includes('--missing-prompt')) { send({ id: message.id, error: { code: -32601, message: 'Method not found: session/prompt' } }); return; }
    prompt(message).catch(error => { console.error(error); process.exit(9); });
  } else if (message.method === 'session/cancel') {
    if (activePrompt !== undefined && !ignoreCancel) result(activePrompt, { stopReason: 'cancelled' });
  }
});

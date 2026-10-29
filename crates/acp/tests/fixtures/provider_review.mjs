// Deterministic peer for the opt-in review harness. Only the direct-write fault touches its owned file.
import readline from 'node:readline';
import { writeFile } from 'node:fs/promises';
const input = readline.createInterface({ input: process.stdin });
const callbacks = new Map();
let sequence = 100;
let cwd = '';
let prompts = 0;
const currentSonnet = process.argv.includes('--current-sonnet');
let model = currentSonnet ? 'sonnet' : 'claude-sonnet-4-5';
let mode = 'default';
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const result = (id, value) => send({ id, result: value });
const options = () => [
  { id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: model, options: [{ value: currentSonnet ? 'sonnet' : 'claude-sonnet-4-5', name: currentSonnet ? 'Sonnet 5.5' : 'Sonnet 4.5' }] },
  { id: 'mode', category: 'mode', type: 'select', name: 'Approval mode', currentValue: mode, options: [{ value: 'default', name: 'Ask before edits' }] },
];
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  callbacks.set(id, { resolve, reject });
  send({ id, method, params });
});
async function prompt(message) {
  if (++prompts > 2) throw new Error('Smoke sent more than two turns');
  const sessionId = message.params.sessionId;
  const path = `${cwd}/greeting.txt`;
  if (process.argv.includes('--direct-write')) {
    await writeFile(path, 'unreviewed native write\n');
    result(message.id, { stopReason: 'end_turn' });
    return;
  }
  if (process.argv.includes('--no-callbacks')) {
    const text = `ACP filesystem callbacks are unavailable for ${path}. No file was changed.`;
    // Split the private path across chunks to exercise whole-reply redaction.
    const middle = text.indexOf(cwd) + Math.floor(cwd.length / 2);
    for (const chunk of [text.slice(0, middle), text.slice(middle)]) {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } } });
    }
    result(message.id, { stopReason: 'end_turn' });
    return;
  }
  const content = prompts === 1 ? 'hello rejected\n' : 'hello span\n';
  const read = await call('fs/read_text_file', { sessionId, path });
  if (read.content !== 'hello\n') throw new Error('Unexpected editor buffer before review');
  const permission = await call('session/request_permission', {
    sessionId, toolCall: { toolCallId: `edit-${prompts}`, title: 'Edit greeting', kind: 'edit', rawInput: { file_path: path } },
    options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
  });
  if (permission.outcome.optionId !== 'yes') throw new Error('Owned-file edit permission was not allowed');
  let rejected = false;
  try { await call('fs/write_text_file', { sessionId, path, content }); } catch { rejected = true; }
  if (rejected !== (prompts === 1)) throw new Error('Unexpected review outcome');
  result(message.id, { stopReason: 'end_turn' });
}
input.on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    const callback = callbacks.get(message.id);
    callbacks.delete(message.id);
    if (callback) message.error ? callback.reject(message.error) : callback.resolve(message.result);
    return;
  }
  if (message.method === 'initialize') result(message.id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: process.argv.includes('--claude-native') ? 'claude-acp' : process.argv.includes('--codex-native') ? 'codex-acp' : 'span-provider-review-fixture', version: '1.0.0' } });
  else if (message.method === 'session/new') { cwd = message.params.cwd; result(message.id, { sessionId: 'review-smoke', configOptions: options() }); }
  else if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'model') model = message.params.value;
    if (message.params.configId === 'mode') mode = message.params.value;
    if (message.params.configId === 'model' && (process.argv.includes('--revert-model') || process.argv.includes('--revert-mode'))) {
      send({ method: 'session/update', params: { sessionId: 'review-smoke', update: { sessionUpdate: 'config_option_update', configOptions: options() } } });
      if (process.argv.includes('--revert-model')) model = 'other-model';
      if (process.argv.includes('--revert-mode')) mode = 'bypassPermissions';
    }
    result(message.id, { configOptions: options() });
  } else if (message.method === 'session/prompt') prompt(message).catch(() => {
    send({ id: message.id, error: { code: -32603, message: 'Provider review fixture failed' } });
  });
});

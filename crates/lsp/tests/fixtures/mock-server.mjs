#!/usr/bin/env node
// Mock LSP server for integration testing.
// Implements LSP 3.17 protocol with Content-Length framing.

import { stdin, stdout, stderr } from 'node:process';

const MODE = process.argv[2] || 'normal';

// Persistent read state
let readBuffer = Buffer.alloc(0);
let pendingMessages = [];

function readMessage() {
  return new Promise((resolve) => {
    // Check if we have a pending message
    if (pendingMessages.length > 0) {
      resolve(pendingMessages.shift());
      return;
    }

    // Parse any complete messages in buffer
    tryParseMessages();

    if (pendingMessages.length > 0) {
      resolve(pendingMessages.shift());
      return;
    }

    // Set up listener for more data
    const onData = (chunk) => {
      readBuffer = Buffer.concat([readBuffer, chunk]);
      tryParseMessages();

      if (pendingMessages.length > 0) {
        stdin.off('data', onData);
        resolve(pendingMessages.shift());
      }
    };

    stdin.on('data', onData);
  });
}

function tryParseMessages() {
  while (true) {
    if (readBuffer.length === 0) break;

    // Find header end
    const headerEnd = readBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (readBuffer.length > 1024) {
        throw new Error('Headers too large');
      }
      break;
    }

    // Parse Content-Length
    const headers = readBuffer.slice(0, headerEnd).toString('utf-8');
    const match = headers.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      throw new Error('Missing Content-Length');
    }

    const contentLength = parseInt(match[1], 10);
    const messageStart = headerEnd + 4;

    // Check if we have the full message
    if (readBuffer.length < messageStart + contentLength) {
      break;
    }

    // Extract message
    const messageBytes = readBuffer.slice(messageStart, messageStart + contentLength);
    const message = JSON.parse(messageBytes.toString('utf-8'));
    pendingMessages.push(message);

    // Remove processed data
    readBuffer = readBuffer.slice(messageStart + contentLength);
  }
}

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const content = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
  stdout.write(content);
}

function sendFragmented(msg) {
  const json = JSON.stringify(msg);
  const content = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;

  // Send in small chunks
  for (let i = 0; i < content.length; i += 10) {
    stdout.write(content.slice(i, i + 10));
  }
}

function sendCoalesced(msg1, msg2) {
  const json1 = JSON.stringify(msg1);
  const json2 = JSON.stringify(msg2);
  const content1 = `Content-Length: ${Buffer.byteLength(json1)}\r\n\r\n${json1}`;
  const content2 = `Content-Length: ${Buffer.byteLength(json2)}\r\n\r\n${json2}`;
  stdout.write(content1 + content2);
}

async function normalMode() {
  const initMsg = await readMessage();
  if (initMsg.method !== 'initialize') {
    throw new Error(`Expected initialize, got ${initMsg.method}`);
  }

  sendMessage({
    jsonrpc: '2.0',
    id: initMsg.id,
    result: {
      capabilities: {
        textDocumentSync: 2,
        completionProvider: { triggerCharacters: ['.'] },
        hoverProvider: true,
      },
    },
  });

  const initializedMsg = await readMessage();
  if (initializedMsg.method !== 'initialized') {
    throw new Error(`Expected initialized, got ${initializedMsg.method}`);
  }

  let shutdownReceived = false;

  while (true) {
    const msg = await readMessage();

    if (msg.method === 'shutdown') {
      shutdownReceived = true;
      sendMessage({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'exit') {
      if (!shutdownReceived) {
        stderr.write('ERROR: exit received without shutdown\n');
        process.exit(1);
      }
      break;
    } else if (msg.method === 'textDocument/completion') {
      sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: [{ label: 'test_completion', kind: 1 }],
      });
    } else if (msg.method === 'textDocument/hover') {
      sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: { contents: { kind: 'plaintext', value: 'Test hover' } },
      });
    } else if (msg.method === 'textDocument/didOpen') {
      sendMessage({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: msg.params.textDocument.uri,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              severity: 1,
              message: 'Test diagnostic',
            },
          ],
        },
      });
    } else if (msg.method === 'textDocument/didChange') {
      // Acknowledge
    } else if (msg.method === 'textDocument/didClose') {
      // Acknowledge
    } else if (msg.method === '$/cancelRequest') {
      // Cancellation received
    }
  }
}

async function fragmentedMode() {
  const initMsg = await readMessage();
  sendFragmented({
    jsonrpc: '2.0',
    id: initMsg.id,
    result: { capabilities: { textDocumentSync: 1, completionProvider: {} } },
  });

  await readMessage(); // initialized

  const req1 = await readMessage();
  const req2 = await readMessage();

  sendCoalesced(
    { jsonrpc: '2.0', id: req1.id, result: [{ label: 'item1', kind: 1 }] },
    { jsonrpc: '2.0', id: req2.id, result: [{ label: 'item2', kind: 1 }] }
  );

  const shutdownMsg = await readMessage();
  sendFragmented({ jsonrpc: '2.0', id: shutdownMsg.id, result: null });

  await readMessage(); // exit
}

async function timeoutMode() {
  const initMsg = await readMessage();
  sendMessage({
    jsonrpc: '2.0',
    id: initMsg.id,
    result: { capabilities: { completionProvider: {} } },
  });

  await readMessage(); // initialized
  await readMessage(); // request that will timeout

  // Sleep indefinitely
  await new Promise(() => {});
}

async function crashMode() {
  const initMsg = await readMessage();
  sendMessage({
    jsonrpc: '2.0',
    id: initMsg.id,
    result: { capabilities: {} },
  });

  await readMessage(); // initialized
  await readMessage(); // some request

  process.exit(1);
}

async function stderrMode() {
  const initMsg = await readMessage();

  for (let i = 0; i < 100; i++) {
    stderr.write(`[stderr] Line ${i}\n`);
  }

  sendMessage({
    jsonrpc: '2.0',
    id: initMsg.id,
    result: { capabilities: {} },
  });

  await readMessage(); // initialized

  const shutdownMsg = await readMessage();
  sendMessage({ jsonrpc: '2.0', id: shutdownMsg.id, result: null });

  await readMessage(); // exit
}

async function malformedMode() {
  stdout.write('Invalid message\r\n\r\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function serverRequestMode() {
  const initMsg = await readMessage();
  sendMessage({
    jsonrpc: '2.0',
    id: initMsg.id,
    result: { capabilities: {} },
  });

  await readMessage(); // initialized

  // Send a server-initiated request
  sendMessage({
    jsonrpc: '2.0',
    id: 999,
    method: 'workspace/configuration',
    params: { items: [{ section: 'test' }] },
  });

  // Wait for the client response
  const response = await readMessage();
  if (response.id !== 999) {
    throw new Error(`Expected response to request 999, got ${JSON.stringify(response)}`);
  }

  if (!response.result || response.result.value !== 'test-response') {
    throw new Error(`Expected test-response, got ${JSON.stringify(response.result)}`);
  }

  const shutdownMsg = await readMessage();
  sendMessage({ jsonrpc: '2.0', id: shutdownMsg.id, result: null });

  await readMessage(); // exit
}

async function cancelMode() {
  const initMsg = await readMessage();
  sendMessage({
    jsonrpc: '2.0',
    id: initMsg.id,
    result: { capabilities: { completionProvider: {} } },
  });

  await readMessage(); // initialized

  const req = await readMessage();

  // Wait for cancel notification
  const cancel = await readMessage();
  if (cancel.method !== '$/cancelRequest') {
    throw new Error(`Expected cancelRequest, got ${cancel.method}`);
  }

  // Don't respond to the original request, it was cancelled

  const shutdownMsg = await readMessage();
  sendMessage({ jsonrpc: '2.0', id: shutdownMsg.id, result: null });

  await readMessage(); // exit
}

async function main() {
  try {
    switch (MODE) {
      case 'normal':
        await normalMode();
        break;
      case 'fragmented':
        await fragmentedMode();
        break;
      case 'timeout':
        await timeoutMode();
        break;
      case 'crash':
        await crashMode();
        break;
      case 'stderr':
        await stderrMode();
        break;
      case 'malformed':
        await malformedMode();
        break;
      case 'server-request':
        await serverRequestMode();
        break;
      case 'cancel':
        await cancelMode();
        break;
      default:
        throw new Error(`Unknown mode: ${MODE}`);
    }
  } catch (err) {
    stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();

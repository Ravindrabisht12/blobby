#!/usr/bin/env node
// Blobby MCP server over stdio (Claude Desktop, Claude Code, Cursor, …).
// Edits project files directly, so it works with the app closed. Talks to the running app over a
// local bridge for screenshots, site analysis, QA, selection and live "follow the AI".

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as store from '../shared/store.js';
import { createBlobbyServer } from './tools.js';

const BRIDGE_FILE = path.join(store.ROOT, '.bridge.json');

function bridgeInfo() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8')); } catch { return null; }
}

async function call(method, params = {}, { timeout = 60000 } = {}) {
  const info = bridgeInfo();
  if (!info || !info.port) throw new Error('Blobby app is not running');
  const res = await fetch(`http://127.0.0.1:${info.port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blobby-token': info.token },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}

async function running() {
  try { await call('ping', {}, { timeout: 1500 }); return true; } catch { return false; }
}

// Starts the app if needed, using the launch command it recorded the last time it ran.
async function ensure() {
  if (await running()) return true;
  const launch = bridgeInfo()?.launch;
  if (!launch) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(launch.command, launch.args, { detached: true, stdio: 'ignore', env }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await running()) return true;
  }
  return false;
}

const server = createBlobbyServer({ call, running, ensure });
await server.connect(new StdioServerTransport());

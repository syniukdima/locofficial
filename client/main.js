// Import the SDK
import { DiscordSDK } from "@discord/embedded-app-sdk";

import "./style.css";
import rocketLogo from '/rocket.png';

// Instantiate the SDK
const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

// Simple ID generator for requests
function generateRequestId() {
  return Math.random().toString(36).slice(2, 10);
}

// Basic logger
function appendLog(message) {
  const el = document.getElementById('log');
  if (!el) return;
  const line = document.createElement('div');
  line.textContent = typeof message === 'string' ? message : JSON.stringify(message);
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

let ws;
let wsStatusEl;
let wsUrl = import.meta.env.VITE_REALTIME_URL;

function connectWs() {
  if (!wsUrl) {
    appendLog("VITE_REALTIME_URL не задано");
    updateWsStatus('missing-url');
    return;
  }
  try {
    appendLog({ connecting: wsUrl });
    ws = new WebSocket(wsUrl);
  } catch (e) {
    appendLog(`WS error: ${e?.message || e}`);
    updateWsStatus('error');
    return;
  }

  ws.onopen = () => {
    updateWsStatus('connected');
    appendLog({ type: 'connected', url: wsUrl });
  };

  ws.onmessage = (ev) => {
    appendLog({ inbound: ev.data });
  };

  ws.onclose = (ev) => {
    updateWsStatus('closed');
    appendLog({ type: 'closed', code: ev.code, reason: ev.reason });
    // lightweight reconnect
    setTimeout(() => {
      updateWsStatus('reconnecting');
      connectWs();
    }, 1500);
  };

  ws.onerror = (ev) => {
    updateWsStatus('error');
    appendLog({ type: 'error', event: ev?.message || 'ws error' });
  };
}

function updateWsStatus(state) {
  if (!wsStatusEl) return;
  const map = {
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    closed: 'Closed',
    error: 'Error',
    'missing-url': 'Missing VITE_REALTIME_URL',
  };
  wsStatusEl.textContent = map[state] || state;
}

function send(type, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    appendLog('WS not connected');
    return;
  }
  const requestId = generateRequestId();
  ws.send(JSON.stringify({ type, requestId, data }));
  appendLog({ outbound: { type, requestId, data } });
}

async function setupDiscordSdk() {
  await discordSdk.ready();
  console.log("Discord SDK is ready");
  const sdkBadge = document.getElementById('sdk-badge');
  if (sdkBadge) sdkBadge.textContent = 'SDK ready';
  // Connect WS after SDK is ready (Discord iframe policies)
  connectWs();
}

// Render UI
document.querySelector('#app').innerHTML = `
  <div>
    <img src="${rocketLogo}" class="logo" alt="Discord" />
    <h1>Hello, World!</h1>
    <div id="sdk-badge" style="margin: 4px 0; font-size: 12px; opacity: .8;">SDK initializing…</div>
    <div style="margin: 8px 0;">
      <div>WS: <span id="ws-status">Connecting…</span></div>
      <div style="font-size:12px; opacity:.8;">URL: <code id="ws-url"></code></div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
        <input id="room-id" placeholder="Room ID" style="padding:6px;" />
        <button id="create-room">Create</button>
        <button id="join-room">Join</button>
        <button id="leave-room">Leave</button>
        <button id="ping">Ping</button>
      </div>
    </div>
    <div id="log" style="height: 180px; overflow:auto; border:1px solid #444; padding:8px; border-radius:6px;"></div>
  </div>
`;

wsStatusEl = document.getElementById('ws-status');
const wsUrlEl = document.getElementById('ws-url');
if (wsUrlEl) wsUrlEl.textContent = wsUrl || '(not set)';
setupDiscordSdk();

// Wire actions
document.getElementById('create-room').addEventListener('click', () => {
  send('create_room', {});
});
document.getElementById('join-room').addEventListener('click', () => {
  const roomId = /** @type {HTMLInputElement} */(document.getElementById('room-id')).value.trim();
  send('join_room', { roomId });
});
document.getElementById('leave-room').addEventListener('click', () => {
  send('leave_room', {});
});
document.getElementById('ping').addEventListener('click', () => {
  send('heartbeat', { now: Date.now() });
});

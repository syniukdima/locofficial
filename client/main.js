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
function appendLog(message, type = 'info') {
  const el = document.getElementById('log');
  if (!el) return;
  const line = document.createElement('div');
  
  // Add styling based on type
  if (type === 'error') {
    line.style.color = '#ff6b6b';
  } else if (type === 'warn') {
    line.style.color = '#ffd93d';
  } else if (type === 'success') {
    line.style.color = '#6bcf7f';
  }
  
  const timestamp = new Date().toLocaleTimeString('uk-UA');
  const prefix = `[${timestamp}] `;
  line.textContent = prefix + (typeof message === 'string' ? message : JSON.stringify(message));
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// Intercept console methods to show in UI
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = function(...args) {
  originalConsoleLog.apply(console, args);
  appendLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'info');
};

console.error = function(...args) {
  originalConsoleError.apply(console, args);
  appendLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'error');
};

console.warn = function(...args) {
  originalConsoleWarn.apply(console, args);
  appendLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'warn');
};

let ws;
let wsStatusEl;
// Always use relative path - Discord will proxy to your backend via URL Mappings
let wsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';

function connectWs() {
  // Debug logging
  console.log('[WS] Attempting connection...', { 
    wsUrl, 
    allEnv: import.meta.env,
    origin: window.location.origin
  });
  
  if (!wsUrl) {
    const msg = "VITE_REALTIME_URL не задано";
    console.error('[WS]', msg);
    appendLog(msg);
    updateWsStatus('missing-url');
    return;
  }
  try {
    console.log('[WS] Creating WebSocket:', wsUrl);
    appendLog({ connecting: wsUrl });
    ws = new WebSocket(wsUrl);
  } catch (e) {
    const msg = `WS error: ${e?.message || e}`;
    console.error('[WS]', msg, e);
    appendLog(msg);
    updateWsStatus('error');
    return;
  }

  ws.onopen = () => {
    console.log('[WS] Connected!');
    updateWsStatus('connected');
    appendLog({ type: 'connected', url: wsUrl });
  };

  ws.onmessage = (ev) => {
    console.log('[WS] Message:', ev.data);
    appendLog({ inbound: ev.data });
  };

  ws.onclose = (ev) => {
    const closeReasons = {
      1000: 'Normal closure',
      1001: 'Going away',
      1002: 'Protocol error',
      1003: 'Unsupported data',
      1006: 'Abnormal closure (no close frame)',
      1007: 'Invalid frame payload',
      1008: 'Policy violation',
      1009: 'Message too big',
      1010: 'Missing extension',
      1011: 'Internal error',
      1015: 'TLS handshake failure'
    };
    const reasonText = closeReasons[ev.code] || 'Unknown';
    console.log('[WS] Closed', { code: ev.code, reason: ev.reason || reasonText, wasClean: ev.wasClean });
    updateWsStatus('closed');
    appendLog({ type: 'closed', code: ev.code, reason: ev.reason || reasonText });
    // lightweight reconnect
    setTimeout(() => {
      updateWsStatus('reconnecting');
      connectWs();
    }, 1500);
  };

  ws.onerror = (ev) => {
    console.error('[WS] Error event', ev);
    console.error('[WS] WebSocket state:', ws.readyState);
    console.error('[WS] URL:', ws.url);
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
  console.log('📡 Ініціалізація Discord SDK...');
  try {
    await discordSdk.ready();
    console.log("✅ Discord SDK готовий!");
    
    // IMPORTANT: Must authenticate before external network requests!
    console.log('🔐 Авторизація користувача...');
    
    // Exchange code for access token via your backend
    const { code } = await discordSdk.commands.authorize({
      client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "guilds"],
    });
    
    console.log('📝 Отримано код авторизації:', code?.substring(0, 10) + '...');
    
    // Exchange code for token via your serverless function
    const response = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Token exchange failed: ${errorData.error || response.statusText}`);
    }
    
    const { access_token } = await response.json();
    
    if (!access_token) {
      throw new Error('No access_token in response');
    }
    
    console.log('🎟️ Отримано access token');
    
    // Authenticate with Discord SDK
    const auth = await discordSdk.commands.authenticate({ access_token });
    console.log('👤 Авторизовано:', auth.user.username, '#' + auth.user.discriminator);
    
    const sdkBadge = document.getElementById('sdk-badge');
    if (sdkBadge) sdkBadge.textContent = `SDK ready — ${auth.user.username}`;
    
    // NOW we can connect to external WebSocket!
    console.log('🔓 Авторизація завершена, підключаємось до WS...');
    connectWs();
  } catch (error) {
    console.error('❌ Помилка Discord SDK:', error);
    appendLog('Помилка авторизації: ' + error.message);
  }
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
    <div id="log" style="height: 300px; overflow:auto; border:1px solid #444; padding:8px; border-radius:6px; font-family: monospace; font-size: 12px; background: #1a1a1a;"></div>
  </div>
`;

wsStatusEl = document.getElementById('ws-status');
const wsUrlEl = document.getElementById('ws-url');
if (wsUrlEl) wsUrlEl.textContent = wsUrl || '(not set)';

// Catch CSP violations and other security errors
window.addEventListener('securitypolicyviolation', (e) => {
  console.error('🚨 CSP Violation!', {
    blockedURI: e.blockedURI,
    violatedDirective: e.violatedDirective,
    originalPolicy: e.originalPolicy
  });
});

// Catch all unhandled errors
window.addEventListener('error', (e) => {
  console.error('❌ Global error:', e.message, e.error);
});

// Initial log message
console.log('🚀 Клієнт запустився');
console.log('WebSocket URL:', wsUrl);
console.log('CLIENT_ID:', import.meta.env.VITE_DISCORD_CLIENT_ID || 'НЕ ЗАДАНО');

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

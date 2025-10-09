// Import the SDK
import { DiscordSDK, patchUrlMappings } from "@discord/embedded-app-sdk";

import "./style.css";
import rocketLogo from '/rocket.png';

// Patch URL mappings for WebSocket proxy
patchUrlMappings([{prefix: '/ws', target: 'locofficial.fly.dev'}]);

// Instantiate the SDK
const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

// Simple ID generator for requests
function generateRequestId() {
  return Math.random().toString(36).slice(2, 10);
}

// UI helpers
function renderPlayers(state) {
  const container = document.getElementById('players');
  const roomLabel = document.getElementById('room-label');
  if (!container) return;
  const players = Array.isArray(state?.players) ? state.players : [];
  if (roomLabel) roomLabel.textContent = state?.roomId ? `Room: ${state.roomId}` : '';
  container.innerHTML = players.map((p) => {
    const name = [p?.username, p?.discriminator && p.discriminator !== '0' ? `#${p.discriminator}` : '']
      .filter(Boolean).join(' ');
    const avatar = p?.avatarUrl || '';
    return (
      `<div class="player-card">` +
        `<img class="avatar" src="${avatar}" alt="${name}" />` +
        `<div class="player-name">${name || 'Unknown'}</div>` +
      `</div>`
    );
  }).join('');
}

let ws;
let wsStatusEl;
// Prefer explicit env URL if provided, fallback to Discord-mapped relative path
let wsUrl = import.meta.env.VITE_REALTIME_URL || '/ws';
let currentProfile = null;
let yourId = null;
let gamePublic = {};
let yourHand = [];

function canPlayClient(card, topCard) {
  if (!card || !topCard) return false;
  return card.color === topCard.color || card.value === topCard.value;
}

function renderTable() {
  const topEl = document.getElementById('top-card');
  const turnEl = document.getElementById('turn-indicator');
  const handEl = document.getElementById('your-hand');
  const playersCountEl = document.getElementById('players-count');
  if (playersCountEl && Array.isArray(gamePublic.players)) {
    playersCountEl.textContent = `Players: ${gamePublic.players.length}`;
  }

  // Top card
  if (topEl) {
    const c = gamePublic.topCard;
    if (c) {
      topEl.innerHTML = `<div class="card ${c.color}"><span class="card-value">${c.value}</span></div>`;
    } else {
      topEl.innerHTML = `<div class="card placeholder"><span class="card-value">?</span></div>`;
    }
  }

  // Turn indicator
  if (turnEl) {
    const you = yourId && gamePublic.currentPlayerId === yourId;
    const who = gamePublic.currentPlayerId || '';
    turnEl.textContent = gamePublic.phase === 'playing'
      ? (you ? 'Your turn' : `Turn: ${who}`)
      : (gamePublic.phase === 'ended' ? 'Game ended' : 'Lobby');
  }

  // Your hand
  if (handEl) {
    const top = gamePublic.topCard;
    handEl.innerHTML = yourHand.map((c, idx) => {
      const playable = canPlayClient(c, top);
      const cls = `card ${c.color} ${playable ? 'playable' : 'disabled'}`;
      const data = encodeURIComponent(JSON.stringify(c));
      return `<button class="${cls}" data-card="${data}" title="${c.color}${c.value}"><span class="card-value">${c.value}</span></button>`;
    }).join('');
    // attach handlers
    Array.from(handEl.querySelectorAll('button.card.playable')).forEach(btn => {
      btn.addEventListener('click', () => {
        try {
          const c = JSON.parse(decodeURIComponent(btn.getAttribute('data-card')));
          send('play', { card: c });
        } catch {}
      });
    });
  }
}

function connectWs() {
  console.log('[WS] Attempting connection...', { wsUrl, origin: window.location.origin });
  
  if (!wsUrl) {
    const msg = "VITE_REALTIME_URL не задано";
    console.error('[WS]', msg);
    updateWsStatus('missing-url');
    return;
  }
  try {
    console.log('[WS] Creating WebSocket:', wsUrl);
    ws = new WebSocket(wsUrl);
  } catch (e) {
    const msg = `WS error: ${e?.message || e}`;
    console.error('[WS]', msg, e);
    updateWsStatus('error');
    return;
  }

  ws.onopen = () => {
    console.log('[WS] Connected!');
    updateWsStatus('connected');
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg?.type === 'room_update' && msg?.data) {
        renderPlayers(msg.data);
      } else if (msg?.type === 'joined' || msg?.type === 'room_created') {
        if (currentProfile) {
          send('identify', currentProfile);
        }
      } else if (msg?.type === 'snapshot' && msg?.data) {
        // private snapshot
        gamePublic = {
          roomId: msg.data.roomId,
          players: msg.data.players || [],
          topCard: msg.data.topCard || null,
          currentPlayerId: msg.data.currentPlayerId || null,
          phase: msg.data.phase || 'lobby',
        };
        yourHand = Array.isArray(msg.data.yourHand) ? msg.data.yourHand : [];
        renderPlayers(gamePublic);
        renderTable();
      } else if (msg?.type === 'state_update' && msg?.data) {
        // public update
        gamePublic = {
          roomId: msg.data.roomId,
          players: msg.data.players || [],
          topCard: msg.data.topCard || null,
          currentPlayerId: msg.data.currentPlayerId || null,
          phase: msg.data.phase || 'lobby',
        };
        renderPlayers(gamePublic);
        renderTable();
      } else if (msg?.type === 'winner' && msg?.data) {
        gamePublic.phase = 'ended';
        renderTable();
        alert(msg.data.playerId === yourId ? 'You win!' : `Winner: ${msg.data.playerId}`);
      }
    } catch {
      // non-JSON messages
    }
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
    
    // Don't reconnect on 1006 - likely misconfiguration
    if (ev.code === 1006) {
      console.error('[WS] Code 1006 означає що Discord не може проксувати WebSocket. Перевір URL Mappings в Portal.');
      updateWsStatus('error');
      return;
    }
    
    // lightweight reconnect for other errors
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
    console.warn('WS not connected');
    return;
  }
  const requestId = generateRequestId();
  ws.send(JSON.stringify({ type, requestId, data }));
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

    // Prepare profile for identify
    const user = auth.user;
    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;
    currentProfile = {
      id: user.id,
      username: user.username,
      discriminator: String(user.discriminator ?? '0'),
      avatarUrl,
    };
    yourId = user.id;
    
    const sdkBadge = document.getElementById('sdk-badge');
    if (sdkBadge) sdkBadge.textContent = `SDK ready — ${auth.user.username}`;
    
    // NOW we can connect to external WebSocket!
    console.log('🔓 Авторизація завершена, підключаємось до WS...');
    connectWs();
  } catch (error) {
    console.error('❌ Помилка Discord SDK:', error);
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
        <button id="start-game">Start</button>
        <button id="draw-card">Draw</button>
        <button id="pass-turn">Pass</button>
      </div>
    </div>
    <div id="room-label" style="margin: 12px 0; font-size: 14px; opacity: .8;"></div>
    <div id="players" class="players-grid"></div>
    <div style="margin-top:16px; display:flex; gap:16px; align-items:flex-start; justify-content:center; flex-wrap:wrap;">
      <div>
        <div style="margin-bottom:6px; opacity:.8;">Top card</div>
        <div id="top-card" class="card-slot"></div>
        <div id="turn-indicator" style="margin-top:8px; font-size:14px; opacity:.9;"></div>
        <div id="players-count" style="margin-top:4px; font-size:12px; opacity:.7;"></div>
      </div>
      <div style="min-width:260px; max-width:600px;">
        <div style="margin-bottom:6px; opacity:.8;">Your hand</div>
        <div id="your-hand" class="hand-row"></div>
      </div>
    </div>
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

// No-op HTTP test removed

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
document.getElementById('start-game').addEventListener('click', () => {
  send('start', {});
});
document.getElementById('draw-card').addEventListener('click', () => {
  send('draw', {});
});
document.getElementById('pass-turn').addEventListener('click', () => {
  send('pass', {});
});

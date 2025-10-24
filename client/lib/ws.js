import { getWsUrl, setWs, getWs, getCurrentProfile, getSender, setSender } from './state.js';

export function updateWsStatus(state) {
  const wsStatusEl = document.getElementById('ws-status');
  if (!wsStatusEl) return;
  const map = { connected: 'Connected', reconnecting: 'Reconnecting…', closed: 'Closed', error: 'Error', 'missing-url': 'Missing VITE_REALTIME_URL' };
  wsStatusEl.textContent = map[state] || state;
}

export function send(type, data) {
  const ws = getWs();
  if (!ws || ws.readyState !== WebSocket.OPEN) { console.warn('WS not connected'); return; }
  const requestId = Math.random().toString(36).slice(2, 10);
  ws.send(JSON.stringify({ type, requestId, data }));
}

setSender(() => send);

export function connectWs(onMessage) {
  const wsUrl = getWsUrl();
  if (!wsUrl) { updateWsStatus('missing-url'); return; }
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error('[WS] create error', e);
    updateWsStatus('error');
    return;
  }
  setWs(ws);

  ws.onopen = () => {
    updateWsStatus('connected');
    const profile = getCurrentProfile();
    if (profile) { send('identify', profile); }
  };
  ws.onmessage = onMessage;
  ws.onclose = (ev) => {
    updateWsStatus('closed');
    if (ev.code === 1006) { updateWsStatus('error'); return; }
    setTimeout(() => { updateWsStatus('reconnecting'); connectWs(onMessage); }, 1500);
  };
  ws.onerror = () => { updateWsStatus('error'); };
}





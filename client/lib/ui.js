import { getGamePublic, getYourHand, getYourId, getView } from './state.js';

export function renderPlayers(state) {
  const container = document.getElementById('players');
  const roomLabel = document.getElementById('room-label');
  if (!container) return;
  const players = Array.isArray(state?.players) ? state.players : [];
  if (roomLabel) roomLabel.textContent = state?.roomId ? `Room: ${state.roomId}` : '';
  container.innerHTML = players.map((p) => {
    const name = [p?.username, p?.discriminator && p.discriminator !== '0' ? `#${p.discriminator}` : '']
      .filter(Boolean).join(' ');
    const avatar = p?.avatarUrl || '';
    const ready = p?.ready ? '✅' : '⏳';
    return (
      `<div class="player-card">` +
        `<img class="avatar" src="${avatar}" alt="${name}" />` +
        `<div class="player-name">${name || 'Unknown'}</div>` +
        `<div class="player-meta">${ready}</div>` +
      `</div>`
    );
  }).join('');
}

export function renderLobbyScreen() {
  const app = document.getElementById('app');
  if (!app) return;
  const gp = getGamePublic();
  app.querySelector('#lobby-controls')?.classList.remove('hidden');
  app.querySelector('#game-screen')?.classList.add('hidden');
  renderPlayers(gp);
}

export function renderGameScreen() {
  const app = document.getElementById('app');
  if (!app) return;
  app.querySelector('#lobby-controls')?.classList.add('hidden');
  app.querySelector('#game-screen')?.classList.remove('hidden');
  renderTable();
}

export function canPlayClient(card, topCard) {
  if (!card || !topCard) return false;
  return card.color === topCard.color || card.value === topCard.value;
}

export function renderTable() {
  const gp = getGamePublic();
  const yourId = getYourId();
  const yourHand = getYourHand();
  const root = document.getElementById('app');
  if (!root) return;
  if (getView() === 'game') {
    root.classList.add('view-game');
  } else {
    root.classList.remove('view-game');
  }
  const topEl = document.getElementById('top-card');
  const turnEl = document.getElementById('turn-indicator');
  const handEl = document.getElementById('your-hand');
  const playersCountEl = document.getElementById('players-count');
  if (playersCountEl && Array.isArray(gp.players)) {
    playersCountEl.textContent = `Players: ${gp.players.length}`;
  }
  if (topEl) {
    const c = gp.topCard;
    if (c) topEl.innerHTML = `<div class="card ${c.color}"><span class="card-value">${c.value}</span></div>`;
    else topEl.innerHTML = `<div class="card placeholder"><span class="card-value">?</span></div>`;
  }
  if (turnEl) {
    const you = yourId && gp.currentPlayerId === yourId;
    const who = gp.currentPlayerId || '';
    turnEl.textContent = gp.phase === 'playing' ? (you ? 'Your turn' : `Turn: ${who}`) : (gp.phase === 'ended' ? 'Game ended' : 'Lobby');
  }
  if (handEl) {
    const top = gp.topCard;
    handEl.innerHTML = yourHand.map((c) => {
      const playable = canPlayClient(c, top);
      const cls = `card ${c.color} ${playable ? 'playable' : 'disabled'}`;
      const data = encodeURIComponent(JSON.stringify(c));
      return `<button class="${cls}" data-card="${data}" title="${c.color}${c.value}"><span class="card-value">${c.value}</span></button>`;
    }).join('');
  }
}





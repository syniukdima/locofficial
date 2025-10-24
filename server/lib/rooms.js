import { createDeck, shuffleInPlace, cardEquals, canPlay } from './game.js';

export const rooms = new Map(); // key -> Room
export const userIdToRoomId = new Map(); // userId -> roomKey

export function createShortRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function makeRoomKey(guildId, shortId) {
  return `${guildId}:${shortId}`;
}

export function getPlayerId(socket) {
  return socket?.__profile?.id || `anon-${(socket?._socket?.remoteAddress || "").replace(/[:.]/g, "")}`;
}

export function ensureGame(room) {
  if (!room.game) {
    room.game = {
      phase: "lobby",
      playersOrder: [],
      hands: new Map(),
      drawPile: [],
      discardTop: null,
      currentTurnIndex: 0,
      lastTurnAt: 0,
    };
  }
  return room.game;
}

export function getRoomState(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return { roomId: null, players: [] };
  const players = [];
  for (const s of room.players) {
    const p = s.__profile || {};
    players.push({
      id: p.id || null,
      username: p.username || null,
      discriminator: p.discriminator || null,
      avatarUrl: p.avatarUrl || null,
      ready: !!(room.readyById && p.id && room.readyById.has(p.id)),
    });
  }
  return { roomId: room.id, players, hostId: room.hostId || null };
}

export function buildPublicState(room) {
  const state = getRoomState(room?.key || "");
  if (room?.game) {
    state.topCard = room.game.discardTop;
    state.currentPlayerId = room.game.playersOrder[room.game.currentTurnIndex] || null;
    state.players = state.players.map(p => ({
      ...p,
      cards: room.game.hands.get(p.id)?.length || 0,
    }));
    state.phase = room.game.phase;
  }
  return state;
}

export function buildPrivateSnapshot(room, playerId) {
  const pub = buildPublicState(room);
  return {
    type: "snapshot",
    data: {
      ...pub,
      yourHand: room?.game?.hands.get(playerId) || [],
    }
  };
}

export function send(socket, message) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

export function broadcast(roomKey, message) {
  const room = rooms.get(roomKey);
  if (!room) return;
  for (const s of room.players) {
    send(s, message);
  }
}

export const gameFns = { createDeck, shuffleInPlace, cardEquals, canPlay };





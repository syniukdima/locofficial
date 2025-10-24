import express from "express";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer } from "ws";
// Node 18+ has global fetch; if unavailable, consider installing node-fetch
import { TURN_TIMEOUT_MS, HEARTBEAT_TIMEOUT_MS, PING_INTERVAL_MS } from "./lib/config.js";

dotenv.config({ path: "../.env" });

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => {
  res.send("ok");
});

// Discord token exchange compatible with client /api/token
app.post("/api/token", async (req, res) => {
  try {
    const clientId = process.env.VITE_DISCORD_CLIENT_ID || process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.VITE_DISCORD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET;
    const code = req?.body?.code;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "Missing Discord client credentials" });
    }
    if (!code) {
      return res.status(400).json({ error: "Missing authorization code" });
    }

    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      return res.status(response.status).json({ error: "Discord token exchange failed", details });
    }

    const { access_token } = await response.json();
    return res.status(200).json({ access_token });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

const server = http.createServer(app);
const port = process.env.PORT || 8080;

const wss = new WebSocketServer({ server, path: "/ws" });

// In-memory rooms and connections
// rooms keyed by composite key `${guildId}:${shortId}` to avoid cross-guild collisions
const rooms = new Map(); // roomKey -> { id: shortId, guildId: string, key: string, players: Set<socket>, createdAt: number, hostId?: string, readyById?: Set<string>, game?: UnoGame }
// Reconnect support: map userId -> last joined roomKey
const userIdToRoomId = new Map();
// Timeouts and intervals from config

// UNO helpers
const COLORS = ["R", "G", "B", "Y"]; // red, green, blue, yellow

function createDeck() {
  /** @type {{ color: string, value: number }[]} */
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: 0 }); // one zero per color
    for (let v = 1; v <= 9; v++) {
      deck.push({ color, value: v });
      deck.push({ color, value: v });
    }
  }
  return deck;
}

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

function cardEquals(a, b) {
  return a && b && a.color === b.color && a.value === b.value;
}

function canPlay(card, top) {
  if (!card || !top) return false;
  return card.color === top.color || card.value === top.value;
}

function getPlayerId(socket) {
  return socket?.__profile?.id || `anon-${(socket?._socket?.remoteAddress || "").replace(/[:.]/g, "")}`;
}

function ensureGame(room) {
  if (!room.game) {
    room.game = {
      phase: "lobby",
      playersOrder: [],
      hands: new Map(), // playerId -> Card[]
      drawPile: [],
      discardTop: null,
      currentTurnIndex: 0,
      lastTurnAt: 0,
    };
  }
  return room.game;
}

function buildPublicState(room) {
  const state = getRoomState(room?.key || "");
  if (room?.game) {
    state.topCard = room.game.discardTop;
    state.currentPlayerId = room.game.playersOrder[room.game.currentTurnIndex] || null;
    // add cards count per player
    state.players = state.players.map(p => ({
      ...p,
      cards: room.game.hands.get(p.id)?.length || 0,
    }));
    state.phase = room.game.phase;
  }
  return state;
}

function buildPrivateSnapshot(room, playerId) {
  const pub = buildPublicState(room);
  return {
    type: "snapshot",
    data: {
      ...pub,
      yourHand: room?.game?.hands.get(playerId) || [],
    }
  };
}

function getRoomState(roomKey) {
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

function send(socket, message) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(roomKey, message) {
  const room = rooms.get(roomKey);
  if (!room) return;
  for (const s of room.players) {
    send(s, message);
  }
}

function createShortRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase(); // 6 chars
}
function makeRoomKey(guildId, shortId) {
  return `${guildId}:${shortId}`;
}

wss.on("connection", (socket, req) => {
  const origin = req.headers.origin || 'unknown';
  console.log("WS connection", { origin });

  send(socket, { type: "hello", message: "connected", now: Date.now() });

  // Track low-level ping/pong for liveness
  socket.__lastPong = Date.now();
  socket.on('pong', () => { socket.__lastPong = Date.now(); });

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, requestId, data } = msg || {};

    // Heartbeat
    if (type === "heartbeat") {
      send(socket, { type: "heartbeat_ack", requestId, now: Date.now() });
      return;
    }

    // Create room
    if (type === "create_room") {
      const guildId = socket.__guildId;
      if (!guildId) { send(socket, { type: "error", requestId, error: "missing_guild" }); return; }
      let shortId;
      let key;
      do {
        shortId = createShortRoomId();
        key = makeRoomKey(guildId, shortId);
      } while (rooms.has(key));
      rooms.set(key, { id: shortId, guildId, key, players: new Set([socket]), createdAt: Date.now(), hostId: getPlayerId(socket), readyById: new Set() });
      socket.__roomKey = key;
      send(socket, { type: "room_created", requestId, data: { roomId: shortId } });
      const state = getRoomState(key);
      broadcast(key, { type: "room_update", data: state });
      // If already identified, remember mapping for auto-rejoin
      const uid = getPlayerId(socket);
      if (uid && !uid.startsWith('anon-')) {
        userIdToRoomId.set(uid, key);
      }
      return;
    }

    // Join room
    if (type === "join_room") {
      const shortId = (data && data.roomId || "").toString().trim();
      const guildId = socket.__guildId;
      if (!guildId) { send(socket, { type: "error", requestId, error: "missing_guild" }); return; }
      const key = makeRoomKey(guildId, shortId);
      const room = rooms.get(key);
      if (!room) {
        send(socket, { type: "error", requestId, error: "room_not_found" });
        return;
      }
      // deny join when a game is in progress
      if (room.game && room.game.phase === "playing") {
        send(socket, { type: "error", requestId, error: "game_in_progress" });
        return;
      }
      room.players.add(socket);
      socket.__roomKey = key;
      send(socket, { type: "joined", requestId, data: { roomId: shortId } });
      const state = getRoomState(key);
      broadcast(key, { type: "room_update", data: state });
      // If identified, remember mapping for auto-rejoin
      const uid = getPlayerId(socket);
      if (uid && !uid.startsWith('anon-')) {
        userIdToRoomId.set(uid, key);
      }
      return;
    }

    // Leave room
    if (type === "leave_room") {
      const roomKey = socket.__roomKey;
      if (roomKey && rooms.has(roomKey)) {
        const room = rooms.get(roomKey);
        room.players.delete(socket);
        delete socket.__roomKey;
        send(socket, { type: "left", requestId, data: { roomId: room.id } });
        // Voluntary leave: clear mapping so we don't auto-rejoin
        const uid = getPlayerId(socket);
        if (uid && userIdToRoomId.get(uid) === roomKey) {
          userIdToRoomId.delete(uid);
        }
        if (room.players.size === 0) rooms.delete(roomKey);
        else {
          // if playing, remove from order and adjust turn
          if (room.game && room.game.phase === "playing") {
            const departingId = getPlayerId(socket);
            const idx = room.game.playersOrder.indexOf(departingId);
            if (idx >= 0) {
              room.game.playersOrder.splice(idx, 1);
              room.game.hands.delete(departingId);
              if (room.game.currentTurnIndex >= room.game.playersOrder.length) {
                room.game.currentTurnIndex = 0;
              }
              // if only one left, winner
              if (room.game.playersOrder.length <= 1) {
                const winner = room.game.playersOrder[0] || null;
                broadcast(roomId, { type: "winner", data: { playerId: winner } });
                room.game.phase = "ended";
              }
            }
          }
          const state = getRoomState(roomKey);
          broadcast(roomKey, { type: "room_update", data: state });
        }
      }
      return;
    }

    // Identify: store user profile (and guild) on socket and broadcast state
    if (type === "identify") {
      const profile = data && typeof data === 'object' ? data : {};
      socket.__profile = {
        id: profile.id || null,
        username: profile.username || null,
        discriminator: profile.discriminator || null,
        avatarUrl: profile.avatarUrl || null,
      };
      if (profile.guildId) socket.__guildId = profile.guildId;
      send(socket, { type: "identify_ack", requestId });
      const roomKey = socket.__roomKey;
      // If already in a room, remember mapping and send updates
      if (roomKey && rooms.has(roomKey)) {
        if (profile.id) userIdToRoomId.set(profile.id, roomKey);
        const room = rooms.get(roomKey);
        // If hostId is anon placeholder, upgrade to real id
        if (room && (!room.hostId || room.hostId.startsWith('anon-')) && profile.id) {
          room.hostId = profile.id;
        }
        const state = getRoomState(roomKey);
        broadcast(roomKey, { type: "room_update", data: state });
        // If game is active, send private snapshot to this user
        if (room.game && room.game.phase) {
          send(socket, buildPrivateSnapshot(room, getPlayerId(socket)));
          broadcast(roomKey, { type: "state_update", data: buildPublicState(room) });
        }
      } else {
        // Auto-rejoin: if we have a remembered room for this user
        const rememberedKey = profile.id && userIdToRoomId.get(profile.id);
        if (rememberedKey && rooms.has(rememberedKey)) {
          const room = rooms.get(rememberedKey);
          // prevent cross-guild auto-pull if guildId provided and mismatched
          if (profile.guildId && profile.guildId !== room.guildId) {
            return;
          }
          room.players.add(socket);
          socket.__roomKey = rememberedKey;
          if (!socket.__guildId) socket.__guildId = room.guildId;
          send(socket, { type: "joined", requestId, data: { roomId: room.id } });
          const state = getRoomState(rememberedKey);
          broadcast(rememberedKey, { type: "room_update", data: state });
          // If game in progress, deliver snapshots/state
          if (room.game && room.game.phase) {
            send(socket, buildPrivateSnapshot(room, getPlayerId(socket)));
            broadcast(rememberedKey, { type: "state_update", data: buildPublicState(room) });
          }
        }
      }
      return;
    }

    // Lobby: set_ready { ready: boolean }
    if (type === "set_ready") {
      const roomKey = socket.__roomKey;
      const room = roomKey && rooms.get(roomKey);
      if (!room) { send(socket, { type: "error", requestId, error: "not_in_room" }); return; }
      const pid = getPlayerId(socket);
      if (!pid || pid.startsWith('anon-')) { send(socket, { type: "error", requestId, error: "not_identified" }); return; }
      if (!room.readyById) room.readyById = new Set();
      const isReady = !!(data && data.ready);
      if (isReady) room.readyById.add(pid); else room.readyById.delete(pid);
      // Broadcast updated lobby state with ready flags
      const state = getRoomState(roomKey);
      broadcast(roomKey, { type: "room_update", data: state });
      send(socket, { type: "set_ready_ack", requestId, data: { ready: isReady } });
      return;
    }

    // === UNO GAME HANDLERS ===
    if (type === "start") {
      const roomKey = socket.__roomKey;
      const room = roomKey && rooms.get(roomKey);
      if (!room) { send(socket, { type: "error", requestId, error: "not_in_room" }); return; }
      const pid = getPlayerId(socket);
      if (!room.hostId || room.hostId !== pid) { send(socket, { type: "error", requestId, error: "not_host" }); return; }
      if (room.players.size < 2) { send(socket, { type: "error", requestId, error: "need_2_players" }); return; }
      // All identified players must be ready
      const allReady = Array.from(room.players).every(s => {
        const id = getPlayerId(s);
        return id && !id.startsWith('anon-') && room.readyById && room.readyById.has(id);
      });
      if (!allReady) { send(socket, { type: "error", requestId, error: "not_all_ready" }); return; }

      const game = ensureGame(room);
      if (game.phase === "playing") { send(socket, { type: "error", requestId, error: "already_started" }); return; }

      game.phase = "playing";
      // order based on current players
      game.playersOrder = Array.from(room.players).map(s => getPlayerId(s));
      game.hands = new Map();
      game.drawPile = shuffleInPlace(createDeck());
      game.discardTop = null;
      game.currentTurnIndex = 0;
      game.lastTurnAt = Date.now();

      // deal 7 to each
      for (const pid of game.playersOrder) {
        game.hands.set(pid, []);
      }
      for (let i = 0; i < 7; i++) {
        for (const pid of game.playersOrder) {
          const card = game.drawPile.pop();
          if (card) game.hands.get(pid).push(card);
        }
      }
      // flip first discard (our deck is numeric-only)
      game.discardTop = game.drawPile.pop();

      // send snapshots to each player
      for (const s of room.players) {
        send(s, buildPrivateSnapshot(room, getPlayerId(s)));
      }
      // broadcast public state
      broadcast(roomKey, { type: "state_update", data: buildPublicState(room) });
      return;
    }

    if (type === "play") {
      const roomKey = socket.__roomKey;
      const room = roomKey && rooms.get(roomKey);
      if (!room || !room.game || room.game.phase !== "playing") { send(socket, { type: "error", requestId, error: "not_playing" }); return; }
      const pid = getPlayerId(socket);
      const game = room.game;
      if (game.playersOrder[game.currentTurnIndex] !== pid) { send(socket, { type: "error", requestId, error: "not_your_turn" }); return; }
      const card = data && data.card;
      if (!card || typeof card.color !== 'string' || typeof card.value !== 'number') { send(socket, { type: "error", requestId, error: "invalid_card" }); return; }
      const hand = game.hands.get(pid) || [];
      const idx = hand.findIndex(c => cardEquals(c, card));
      if (idx < 0) { send(socket, { type: "error", requestId, error: "card_not_in_hand" }); return; }
      if (!canPlay(card, game.discardTop)) { send(socket, { type: "error", requestId, error: "illegal_move" }); return; }

      // play the card
      hand.splice(idx, 1);
      game.discardTop = card;

      // winner check
      if (hand.length === 0) {
        broadcast(roomId, { type: "winner", data: { playerId: pid } });
        game.phase = "ended";
      } else {
        // advance turn
        game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playersOrder.length;
        game.lastTurnAt = Date.now();
      }

      // notify
      for (const s of room.players) {
        send(s, buildPrivateSnapshot(room, getPlayerId(s)));
      }
      broadcast(roomKey, { type: "state_update", data: buildPublicState(room) });
      return;
    }

    if (type === "draw") {
      const roomKey = socket.__roomKey;
      const room = roomKey && rooms.get(roomKey);
      if (!room || !room.game || room.game.phase !== "playing") { send(socket, { type: "error", requestId, error: "not_playing" }); return; }
      const pid = getPlayerId(socket);
      const game = room.game;
      if (game.playersOrder[game.currentTurnIndex] !== pid) { send(socket, { type: "error", requestId, error: "not_your_turn" }); return; }

      // if draw pile empty, try to regenerate from discard (minus top). Minimal implementation: error if empty
      if (game.drawPile.length === 0) { send(socket, { type: "error", requestId, error: "no_cards_to_draw" }); return; }
      const card = game.drawPile.pop();
      const hand = game.hands.get(pid) || [];
      hand.push(card);
      // Extend time budget for current player upon action
      game.lastTurnAt = Date.now();

      // send updated snapshots/public
      for (const s of room.players) {
        send(s, buildPrivateSnapshot(room, getPlayerId(s)));
      }
      broadcast(roomKey, { type: "state_update", data: buildPublicState(room) });
      return;
    }

    if (type === "pass") {
      const roomKey = socket.__roomKey;
      const room = roomKey && rooms.get(roomKey);
      if (!room || !room.game || room.game.phase !== "playing") { send(socket, { type: "error", requestId, error: "not_playing" }); return; }
      const pid = getPlayerId(socket);
      const game = room.game;
      if (game.playersOrder[game.currentTurnIndex] !== pid) { send(socket, { type: "error", requestId, error: "not_your_turn" }); return; }
      // advance turn
      game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playersOrder.length;
      game.lastTurnAt = Date.now();

      for (const s of room.players) {
        send(s, buildPrivateSnapshot(room, getPlayerId(s)));
      }
      broadcast(roomKey, { type: "state_update", data: buildPublicState(room) });
      return;
    }

    // Legacy test message
    if (type === "ping") {
      send(socket, { type: "pong", now: Date.now() });
      return;
    }

    // Unknown
    send(socket, { type: "error", requestId, error: "unknown_type", received: type });
  });
  socket.on("close", (code, reason) => {
    console.log("WS close", { code, reason: reason?.toString?.() || "" });
    const roomKey = socket.__roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      room.players.delete(socket);
      if (room.players.size === 0) rooms.delete(roomKey);
      else {
        const state = getRoomState(roomKey);
        broadcast(roomKey, { type: "room_update", data: state });
      }
    }
  });
});

// Global ping/pong and liveness checks
if (!wss.__pingInterval) {
  wss.__pingInterval = setInterval(() => {
    for (const s of wss.clients) {
      try { s.ping(); } catch {}
      const last = s.__lastPong || 0;
      if (Date.now() - last > HEARTBEAT_TIMEOUT_MS) {
        try { s.terminate(); } catch {}
      }
    }
  }, PING_INTERVAL_MS);
}

// Turn timeout auto-pass
if (!wss.__turnInterval) {
  wss.__turnInterval = setInterval(() => {
    for (const [roomId, room] of rooms.entries()) {
      const game = room.game;
      if (!game || game.phase !== 'playing') continue;
      if (!Array.isArray(game.playersOrder) || game.playersOrder.length < 2) continue;
      const last = game.lastTurnAt || Date.now();
      if (Date.now() - last > TURN_TIMEOUT_MS) {
        game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playersOrder.length;
        game.lastTurnAt = Date.now();
        for (const s of room.players) {
          send(s, buildPrivateSnapshot(room, getPlayerId(s)));
        }
        broadcast(roomId, { type: "state_update", data: buildPublicState(room) });
      }
    }
  }, 1000);
}

server.listen(port, "0.0.0.0", () => {
  console.log(`HTTP on :${port} (GET /health), WS on ws://0.0.0.0:${port}/ws`);
});

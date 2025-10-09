import express from "express";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer } from "ws";
// Node 18+ has global fetch; if unavailable, consider installing node-fetch

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
const rooms = new Map(); // roomId -> { players: Set<socket>, createdAt: number, game?: UnoGame }

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
    };
  }
  return room.game;
}

function buildPublicState(room) {
  const state = getRoomState(room?.id || "");
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

function getRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return { roomId, players: [] };
  const players = [];
  for (const s of room.players) {
    const p = s.__profile || {};
    players.push({
      id: p.id || null,
      username: p.username || null,
      discriminator: p.discriminator || null,
      avatarUrl: p.avatarUrl || null,
    });
  }
  return { roomId, players };
}

function send(socket, message) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const s of room.players) {
    send(s, message);
  }
}

function createRoomId() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

wss.on("connection", (socket, req) => {
  const origin = req.headers.origin || 'unknown';
  console.log("WS connection", { origin });

  send(socket, { type: "hello", message: "connected", now: Date.now() });

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
      const roomId = createRoomId();
      rooms.set(roomId, { players: new Set([socket]), createdAt: Date.now(), id: roomId });
      socket.__roomId = roomId;
      send(socket, { type: "room_created", requestId, data: { roomId } });
      const state = getRoomState(roomId);
      broadcast(roomId, { type: "room_update", data: state });
      return;
    }

    // Join room
    if (type === "join_room") {
      const roomId = (data && data.roomId || "").toString().trim();
      const room = rooms.get(roomId);
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
      socket.__roomId = roomId;
      send(socket, { type: "joined", requestId, data: { roomId } });
      const state = getRoomState(roomId);
      broadcast(roomId, { type: "room_update", data: state });
      return;
    }

    // Leave room
    if (type === "leave_room") {
      const roomId = socket.__roomId;
      if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        room.players.delete(socket);
        delete socket.__roomId;
        send(socket, { type: "left", requestId, data: { roomId } });
        if (room.players.size === 0) rooms.delete(roomId);
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
          const state = getRoomState(roomId);
          broadcast(roomId, { type: "room_update", data: state });
        }
      }
      return;
    }

    // Identify: store user profile on socket and broadcast state
    if (type === "identify") {
      const profile = data && typeof data === 'object' ? data : {};
      socket.__profile = {
        id: profile.id || null,
        username: profile.username || null,
        discriminator: profile.discriminator || null,
        avatarUrl: profile.avatarUrl || null,
      };
      send(socket, { type: "identify_ack", requestId });
      const roomId = socket.__roomId;
      if (roomId && rooms.has(roomId)) {
        const state = getRoomState(roomId);
        broadcast(roomId, { type: "room_update", data: state });
      }
      return;
    }

    // === UNO GAME HANDLERS ===
    if (type === "start") {
      const roomId = socket.__roomId;
      const room = roomId && rooms.get(roomId);
      if (!room) { send(socket, { type: "error", requestId, error: "not_in_room" }); return; }
      if (room.players.size < 2) { send(socket, { type: "error", requestId, error: "need_2_players" }); return; }

      const game = ensureGame(room);
      if (game.phase === "playing") { send(socket, { type: "error", requestId, error: "already_started" }); return; }

      game.phase = "playing";
      // order based on current players
      game.playersOrder = Array.from(room.players).map(s => getPlayerId(s));
      game.hands = new Map();
      game.drawPile = shuffleInPlace(createDeck());
      game.discardTop = null;
      game.currentTurnIndex = 0;

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
      broadcast(roomId, { type: "state_update", data: buildPublicState(room) });
      return;
    }

    if (type === "play") {
      const roomId = socket.__roomId;
      const room = roomId && rooms.get(roomId);
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
      }

      // notify
      for (const s of room.players) {
        send(s, buildPrivateSnapshot(room, getPlayerId(s)));
      }
      broadcast(roomId, { type: "state_update", data: buildPublicState(room) });
      return;
    }

    if (type === "draw") {
      const roomId = socket.__roomId;
      const room = roomId && rooms.get(roomId);
      if (!room || !room.game || room.game.phase !== "playing") { send(socket, { type: "error", requestId, error: "not_playing" }); return; }
      const pid = getPlayerId(socket);
      const game = room.game;
      if (game.playersOrder[game.currentTurnIndex] !== pid) { send(socket, { type: "error", requestId, error: "not_your_turn" }); return; }

      // if draw pile empty, try to regenerate from discard (minus top). Minimal implementation: error if empty
      if (game.drawPile.length === 0) { send(socket, { type: "error", requestId, error: "no_cards_to_draw" }); return; }
      const card = game.drawPile.pop();
      const hand = game.hands.get(pid) || [];
      hand.push(card);

      // send updated snapshots/public
      for (const s of room.players) {
        send(s, buildPrivateSnapshot(room, getPlayerId(s)));
      }
      broadcast(roomId, { type: "state_update", data: buildPublicState(room) });
      return;
    }

    if (type === "pass") {
      const roomId = socket.__roomId;
      const room = roomId && rooms.get(roomId);
      if (!room || !room.game || room.game.phase !== "playing") { send(socket, { type: "error", requestId, error: "not_playing" }); return; }
      const pid = getPlayerId(socket);
      const game = room.game;
      if (game.playersOrder[game.currentTurnIndex] !== pid) { send(socket, { type: "error", requestId, error: "not_your_turn" }); return; }
      // advance turn
      game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playersOrder.length;

      for (const s of room.players) {
        send(s, buildPrivateSnapshot(room, getPlayerId(s)));
      }
      broadcast(roomId, { type: "state_update", data: buildPublicState(room) });
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
    const roomId = socket.__roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.players.delete(socket);
      if (room.players.size === 0) rooms.delete(roomId);
      else broadcast(roomId, { type: "room_update", data: { roomId, players: room.players.size } });
    }
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`HTTP on :${port} (GET /health), WS on ws://0.0.0.0:${port}/ws`);
});

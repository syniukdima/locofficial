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
const rooms = new Map(); // roomId -> { players: Set<socket>, createdAt: number }

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
      rooms.set(roomId, { players: new Set([socket]), createdAt: Date.now() });
      socket.__roomId = roomId;
      send(socket, { type: "room_created", requestId, data: { roomId } });
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
      room.players.add(socket);
      socket.__roomId = roomId;
      send(socket, { type: "joined", requestId, data: { roomId } });
      broadcast(roomId, { type: "room_update", data: { roomId, players: room.players.size } });
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
        else broadcast(roomId, { type: "room_update", data: { roomId, players: room.players.size } });
      }
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

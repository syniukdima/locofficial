import express from "express";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer } from "ws";

dotenv.config({ path: "../.env" });

const app = express();
app.get("/health", (_req, res) => {
  res.send("ok");
});

const server = http.createServer(app);
const port = process.env.PORT || 8080;
const allowedOrigin = process.env.ALLOWED_ORIGIN;

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const origin = req.headers.origin;
  if (allowedOrigin && origin && origin !== allowedOrigin) {
    socket.close(1008, "origin not allowed");
    return;
  }

  socket.send(JSON.stringify({ type: "hello", message: "connected", now: Date.now() }));

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", now: Date.now() }));
      return;
    }

    socket.send(JSON.stringify({ type: "echo", data: msg }));
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`HTTP on :${port} (GET /health), WS on ws://0.0.0.0:${port}/ws`);
});

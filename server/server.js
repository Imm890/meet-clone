const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let worker;
let router;

const transports = {};
const producers = {};
const rooms = {}; // Track rooms and their producers

async function createWorker() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });
  console.log(`Mediasoup Worker PID: ${worker.pid}`);
  worker.on("died", () => setTimeout(() => process.exit(1), 2000));
}

async function createRouter() {
  const mediaCodecs = [
    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
    { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
  ];
  router = await worker.createRouter({ mediaCodecs });
  console.log("Mediasoup Router created");
}

async function start() {
  await createWorker();
  await createRouter();

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // 1. Join Room
    socket.on("joinRoom", ({ roomId }, callback) => {
      socket.join(roomId); // Socket.io built-in room feature
      socket.roomId = roomId;

      if (!rooms[roomId]) rooms[roomId] = [];

      // Send back existing producers in this room
      callback({ existingProducers: rooms[roomId] });
    });
    socket.on("getRouterRtpCapabilities", (_, callback) => {
      callback({ routerRtpCapabilities: router.rtpCapabilities });
    });

    socket.on("createWebRtcTransport", async (_, callback) => {
      try {
        const transport = await router.createWebRtcTransport({
          listenIps: [{ ip: "127.0.0.1" }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });
        transports[transport.id] = { socketId: socket.id, transport };
        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) {
        callback({ error: err.message });
      }
    });

    socket.on(
      "connectTransport",
      async ({ dtlsParameters, transportId }, callback) => {
        const transportEntry = transports[transportId];
        if (transportEntry) {
          await transportEntry.transport.connect({ dtlsParameters });
          callback({ connected: true });
        }
      }
    );

    socket.on(
      "transportProduce",
      async ({ kind, rtpParameters, transportId }, callback) => {
        const transportEntry = transports[transportId];
        if (transportEntry) {
          const producer = await transportEntry.transport.produce({
            kind,
            rtpParameters,
          });
          producers[producer.id] = {
            socketId: socket.id,
            producer,
            roomId: socket.roomId,
          };

          // Add to room list
          if (rooms[socket.roomId]) {
            rooms[socket.roomId].push({
              producerId: producer.id,
              socketId: socket.id,
            });
          }

          // Notify others in the room
          socket.to(socket.roomId).emit("newProducer", {
            producerId: producer.id,
            socketId: socket.id,
          });
          callback({ id: producer.id });
        }
      }
    );

    socket.on(
      "consume",
      async ({ rtpCapabilities, producerId, transportId }, callback) => {
        try {
          if (!router.canConsume({ producerId, rtpCapabilities }))
            return callback({ error: "Cannot consume" });
          const transportEntry = transports[transportId];
          if (!transportEntry) return callback({ error: "No transport" });

          const consumer = await transportEntry.transport.consume({
            producerId,
            rtpCapabilities,
            paused: false,
          });
          callback({
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          });
        } catch (err) {
          callback({ error: err.message });
        }
      }
    );

    // 2. Handle Disconnect (Cleanup)
    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      if (socket.roomId && rooms[socket.roomId]) {
        // Remove this user's producers from the room
        rooms[socket.roomId] = rooms[socket.roomId].filter(
          (p) => p.socketId !== socket.id
        );

        // Tell everyone else in the room to remove this user's video
        socket.to(socket.roomId).emit("user-left", { socketId: socket.id });
      }
    });

    socket.on("chatMessage", ({ roomId, text }, cb) => {
      socket.to(roomId).emit("chatMessage", { from: socket.id, text });
    });
    socket.on("reaction", ({ roomId, emoji }) => {
      socket.to(roomId).emit("reaction", { emoji });
    });
    socket.on("micToggle", ({ roomId, muted }) => {
      socket.to(roomId).emit("micToggle", { socketId: socket.id, muted });
    });
  });

  server.listen(3001, () =>
    console.log("Backend server running on http://localhost:3001")
  );
}

start();

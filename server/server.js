const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

let worker;
let router;

// Use objects (dictionaries) instead of arrays for easy lookup by ID
const transports = {};
const producers = {};

async function createWorker() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });
  console.log(`Mediasoup Worker PID: ${worker.pid}`);
  worker.on("died", () => {
    console.error("Mediasoup worker died!");
    setTimeout(() => process.exit(1), 2000);
  });
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

    socket.on("getRouterRtpCapabilities", (data, callback) => {
      callback({ routerRtpCapabilities: router.rtpCapabilities });
    });

    // Create Transport and save it by its transport.id
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

    // Connect Transport using transportId
    socket.on(
      "connectTransport",
      async ({ dtlsParameters, transportId }, callback) => {
        const transportEntry = transports[transportId];
        if (transportEntry) {
          await transportEntry.transport.connect({ dtlsParameters });
          callback({ connected: true });
        } else {
          callback({ error: "Transport not found" });
        }
      }
    );

    // Produce using transportId
    socket.on(
      "transportProduce",
      async ({ kind, rtpParameters, transportId }, callback) => {
        const transportEntry = transports[transportId];
        if (transportEntry) {
          const producer = await transportEntry.transport.produce({
            kind,
            rtpParameters,
          });
          producers[producer.id] = { socketId: socket.id, producer };

          socket.broadcast.emit("newProducer", { producerId: producer.id });
          callback({ id: producer.id });
        }
      }
    );

    // Consume using transportId
    socket.on(
      "consume",
      async ({ rtpCapabilities, producerId, transportId }, callback) => {
        try {
          if (!router.canConsume({ producerId, rtpCapabilities })) {
            return callback({ error: "Cannot consume" });
          }

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
          console.error("Consume error:", err);
          callback({ error: err.message });
        }
      }
    );
  });

  server.listen(3001, () => {
    console.log("Backend server running on http://localhost:3001");
  });
}

start();

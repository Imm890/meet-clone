// client/src/Room.jsx
import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import io from "socket.io-client";
import { Device } from "mediasoup-client";

// ─── Speaking Detection Hook ───────────────────────────────────────────────
function useSpeakingDetection(stream) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!stream) return;
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      setIsSpeaking(avg > 10);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      audioCtx.close();
    };
  }, [stream]);

  return isSpeaking;
}

// ─── Remote Video Tile ─────────────────────────────────────────────────────
function RemoteTile({ remote, index }) {
  const videoRef = useRef(null);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = remote.stream;
  }, [remote.stream]);

  // Detect speaking from audio tracks
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!remote.stream) return;

    const audioTracks = remote.stream.getAudioTracks();

    // لا يوجد صوت
    if (audioTracks.length === 0) return;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(remote.stream);
    const analyser = audioCtx.createAnalyser();

    analyser.fftSize = 512;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);

    let raf;

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      setSpeaking(avg > 10);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      audioCtx.close();
    };
  }, [remote.stream]);

  return (
    <div
      className={`relative bg-[#2a2a2a] rounded-2xl overflow-hidden shadow-lg aspect-video flex items-center justify-center transition-all duration-200 ${
        speaking ? "ring-2 ring-green-400" : ""
      }`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="w-full h-full object-cover"
      />
      <div className="absolute bottom-3 left-3 flex items-center gap-2">
        <span className="bg-black/60 backdrop-blur-sm px-3 py-1 rounded-lg text-sm font-medium text-white">
          User {index + 1}
        </span>
        {remote.isMuted && (
          <span className="bg-red-600/80 backdrop-blur-sm px-2 py-1 rounded-lg text-xs">
            🔇
          </span>
        )}
      </div>
      {speaking && (
        <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-green-400 animate-pulse" />
      )}
    </div>
  );
}

// ─── Main Room Component ───────────────────────────────────────────────────
function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  const socketRef = useRef(null);
  const localVideoRef = useRef(null);
  const streamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const screenProducerRef = useRef(null);
  const chatEndRef = useRef(null);

  const [stream, setStream] = useState(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [serverStatus, setServerStatus] = useState("Connecting...");
  const [videoSentToServer, setVideoSentToServer] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [activePanel, setActivePanel] = useState(null); // 'chat' | 'participants' | null
  const [unreadCount, setUnreadCount] = useState(0);
  const [reactions, setReactions] = useState([]); // [{ id, emoji, x }]

  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  const localSpeaking = useSpeakingDetection(stream);

  // ── Reactions ─────────────────────────────────────────────────────────────
  const sendReaction = (emoji) => {
    socketRef.current.emit("reaction", { roomId, emoji });
    spawnReaction(emoji);
  };

  const spawnReaction = (emoji) => {
    const id = Date.now() + Math.random();
    const x = 20 + Math.random() * 60; // % from left
    setReactions((prev) => [...prev, { id, emoji, x }]);
    setTimeout(
      () => setReactions((prev) => prev.filter((r) => r.id !== id)),
      2800
    );
  };

  // ── Chat ──────────────────────────────────────────────────────────────────
  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    socketRef.current.emit("chatMessage", { roomId, text });
    setChatMessages((prev) => [...prev, { from: "You", text, self: true }]);
    setChatInput("");
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // ── Consume a remote producer ─────────────────────────────────────────────
  const consumeProducer = useCallback(async (producerId, socketId) => {
    const device = deviceRef.current;
    const recvTransport = recvTransportRef.current;
    if (!device || !recvTransport) return;

    socketRef.current.emit(
      "consume",
      {
        rtpCapabilities: device.rtpCapabilities,
        producerId,
        transportId: recvTransport.id,
      },
      async (response) => {
        if (response.error) return console.error(response.error);

        const consumer = await recvTransport.consume({
          id: response.id,
          producerId: response.producerId,
          kind: response.kind,
          rtpParameters: response.rtpParameters,
        });

        const newStream = new MediaStream([consumer.track]);
        setRemoteStreams((prev) => {
          const existing = prev.find((r) => r.socketId === socketId);

          if (existing) {
            const updatedStream = new MediaStream([
              ...existing.stream.getTracks(),
              consumer.track,
            ]);

            return prev.map((r) =>
              r.socketId === socketId ? { ...r, stream: updatedStream } : r
            );
          }

          return [
            ...prev,
            {
              socketId,
              id: producerId,
              stream: new MediaStream([consumer.track]),
            },
          ];
        });
      }
    );
  }, []);

  // ── Mediasoup setup ───────────────────────────────────────────────────────
  const setupMediasoup = useCallback(
    async (existingProducers) => {
      if (deviceRef.current) return;
      try {
        setServerStatus("Setting up...");
        const device = new Device();
        deviceRef.current = device;

        socketRef.current.emit(
          "getRouterRtpCapabilities",
          {},
          async (response) => {
            await device.load({
              routerRtpCapabilities: response.routerRtpCapabilities,
            });
            setServerStatus("Ready");

            // Send Transport
            socketRef.current.emit(
              "createWebRtcTransport",
              {},
              async (transportOptions) => {
                const sendTransport =
                  device.createSendTransport(transportOptions);
                sendTransportRef.current = sendTransport;

                sendTransport.on("connect", ({ dtlsParameters }, callback) => {
                  socketRef.current.emit(
                    "connectTransport",
                    { dtlsParameters, transportId: sendTransport.id },
                    () => callback()
                  );
                });

                sendTransport.on(
                  "produce",
                  ({ kind, rtpParameters }, callback) => {
                    socketRef.current.emit(
                      "transportProduce",
                      { kind, rtpParameters, transportId: sendTransport.id },
                      ({ id }) => {
                        callback({ id });
                        setVideoSentToServer(true);
                      }
                    );
                  }
                );

                if (streamRef.current) {
                  const videoTrack = streamRef.current.getVideoTracks()[0];
                  const audioTrack = streamRef.current.getAudioTracks()[0];
                  if (videoTrack) sendTransport.produce({ track: videoTrack });
                  if (audioTrack) sendTransport.produce({ track: audioTrack });
                }
              }
            );

            // Recv Transport
            socketRef.current.emit(
              "createWebRtcTransport",
              {},
              async (transportOptions) => {
                const recvTransport =
                  device.createRecvTransport(transportOptions);
                recvTransportRef.current = recvTransport;

                recvTransport.on("connect", ({ dtlsParameters }, callback) => {
                  socketRef.current.emit(
                    "connectTransport",
                    { dtlsParameters, transportId: recvTransport.id },
                    () => callback()
                  );
                });

                (existingProducers || []).forEach((p) =>
                  consumeProducer(p.producerId, p.socketId)
                );
              }
            );
          }
        );
      } catch (err) {
        console.error("Mediasoup setup error:", err);
      }
    },
    [consumeProducer]
  );

  // ── Socket setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    socketRef.current = io("http://localhost:3001");

    socketRef.current.on("connect", () => {
      setServerStatus("Connected");
      socketRef.current.emit("joinRoom", { roomId }, (response) => {
        setParticipants(response.participants || []);
        if (streamRef.current) {
          setupMediasoup(response.existingProducers);
        } else {
          window.__existingProducers = response.existingProducers;
        }
      });
    });

    socketRef.current.on("newProducer", ({ producerId, socketId }) => {
      consumeProducer(producerId, socketId);
    });

    socketRef.current.on("user-left", ({ socketId }) => {
      setRemoteStreams((prev) => prev.filter((r) => r.socketId !== socketId));
      setParticipants((prev) => prev.filter((p) => p.socketId !== socketId));
    });

    socketRef.current.on("participantUpdate", (updatedList) => {
      setParticipants(updatedList);
    });

    socketRef.current.on("chatMessage", ({ from, text }) => {
      setChatMessages((prev) => [...prev, { from, text, self: false }]);
      setUnreadCount((prev) => (activePanel === "chat" ? 0 : prev + 1));
    });

    socketRef.current.on("reaction", ({ emoji }) => {
      spawnReaction(emoji);
    });

    socketRef.current.on("mutedByHost", () => {
      stream?.getAudioTracks().forEach((t) => (t.enabled = false));
      setIsMicOn(false);
    });

    return () => socketRef.current?.disconnect();
  }, [roomId]);

  // ── Camera/Mic ────────────────────────────────────────────────────────────
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((currentStream) => {
        setStream(currentStream);
        streamRef.current = currentStream;
        if (localVideoRef.current)
          localVideoRef.current.srcObject = currentStream;

        if (socketRef.current?.connected && window.__existingProducers) {
          setupMediasoup(window.__existingProducers);
          window.__existingProducers = null;
        }
      })
      .catch((err) => console.error("Camera/mic error:", err));
  }, []);

  // Reset unread when chat opens
  useEffect(() => {
    if (activePanel === "chat") setUnreadCount(0);
  }, [activePanel]);

  // ── Controls ──────────────────────────────────────────────────────────────
  const toggleMic = () => {
    stream?.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    setIsMicOn((p) => !p);
    socketRef.current.emit("micToggle", { roomId, muted: isMicOn });
  };

  const toggleVideo = () => {
    stream?.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    setIsVideoOn((p) => !p);
  };

  const toggleScreen = async () => {
    if (isSharingScreen) {
      screenProducerRef.current?.close();
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      setIsSharingScreen(false);
      return;
    }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      screenStreamRef.current = screenStream;
      const screenTrack = screenStream.getVideoTracks()[0];
      const producer = await sendTransportRef.current.produce({
        track: screenTrack,
      });
      screenProducerRef.current = producer;
      setIsSharingScreen(true);
      screenTrack.onended = () => {
        producer.close();
        setIsSharingScreen(false);
      };
    } catch (err) {
      console.error("Screen share error:", err);
    }
  };

  const leaveCall = () => {
    socketRef.current?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    navigate("/");
  };

  // ── Grid layout logic ─────────────────────────────────────────────────────
  const totalTiles = 1 + remoteStreams.length;
  const gridCols =
    totalTiles === 1
      ? "grid-cols-1"
      : totalTiles === 2
      ? "grid-cols-2"
      : totalTiles <= 4
      ? "grid-cols-2"
      : "grid-cols-3";

  return (
    <div className="h-screen flex flex-col bg-[#111] text-white overflow-hidden font-sans">
      {/* ── Floating Reactions ── */}
      <div className="fixed inset-0 pointer-events-none z-50">
        {reactions.map((r) => (
          <div
            key={r.id}
            className="absolute bottom-24 text-4xl animate-bounce"
            style={{
              left: `${r.x}%`,
              animation: "floatUp 2.8s ease-out forwards",
            }}
          >
            {r.emoji}
          </div>
        ))}
      </div>

      <style>{`
        @keyframes floatUp {
          0%   { transform: translateY(0) scale(1); opacity: 1; }
          100% { transform: translateY(-300px) scale(1.4); opacity: 0; }
        }
      `}</style>

      {/* ── Header ── */}
      <header className="flex justify-between items-center px-5 py-3 bg-[#1a1a1a] border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-sm">
            M
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-none">Meet Clone</h1>
            <p className="text-xs text-gray-400 mt-0.5">Room: {roomId}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span
            className={`px-2 py-1 rounded-full ${
              serverStatus === "Ready"
                ? "bg-green-500/20 text-green-400"
                : "bg-yellow-500/20 text-yellow-400"
            }`}
          >
            ● {serverStatus}
          </span>
          {videoSentToServer && (
            <span className="px-2 py-1 rounded-full bg-blue-500/20 text-blue-400">
              📡 Live
            </span>
          )}
        </div>
      </header>

      {/* ── Body ── */}
      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Main Content */}
        <main className="flex-1 p-4 overflow-hidden">
          <div className="h-full flex flex-col gap-4">
            {/* Active speaker area */}
            <div className="flex-1">
              <div
                className={`relative w-full h-full rounded-3xl overflow-hidden bg-[#2d2e30] shadow-xl ${
                  localSpeaking ? "ring-4 ring-green-500" : ""
                }`}
              >
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className={`w-full h-full object-cover ${
                    isVideoOn ? "" : "hidden"
                  }`}
                />

                {!isVideoOn && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-32 h-32 rounded-full bg-gray-600 flex items-center justify-center text-5xl font-bold">
                      Y
                    </div>
                  </div>
                )}

                <div className="absolute bottom-4 left-4 bg-black/50 backdrop-blur px-4 py-2 rounded-xl">
                  You
                </div>

                {!isMicOn && (
                  <div className="absolute top-4 right-4 bg-red-600 rounded-full p-2">
                    🔇
                  </div>
                )}
              </div>
            </div>

            {/* Participants strip */}
            <div className="h-36 shrink-0">
              <div className="flex gap-4 overflow-x-auto pb-2 h-full">
                {/* Local Thumbnail */}
                <div className="w-56 shrink-0 relative rounded-2xl overflow-hidden bg-[#3c4043]">
                  <video
                    ref={localVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className={`w-full h-full object-cover ${
                      isVideoOn ? "" : "hidden"
                    }`}
                  />

                  {!isVideoOn && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-16 h-16 rounded-full bg-gray-600 flex items-center justify-center">
                        Y
                      </div>
                    </div>
                  )}

                  <div className="absolute bottom-2 left-2 bg-black/50 px-2 py-1 rounded text-xs">
                    You
                  </div>
                </div>

                {/* Remote Users */}
                {remoteStreams.map((remote, index) => (
                  <div key={remote.socketId} className="w-56 shrink-0">
                    <RemoteTile remote={remote} index={index} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>

        {/* Right Side Panel */}
        {activePanel && (
          <aside
            className="
      w-[360px]
      bg-[#202124]
      border-l
      border-gray-700
      flex
      flex-col
      shrink-0
      "
          >
            <div className="flex justify-between items-center p-4 border-b border-gray-700">
              <h2 className="font-semibold capitalize">{activePanel}</h2>

              <button onClick={() => setActivePanel(null)} className="text-xl">
                ×
              </button>
            </div>

            {activePanel === "participants" && (
              <div className="p-4 overflow-auto space-y-3">
                <div className="p-3 rounded-xl bg-white/5">You</div>

                {remoteStreams.map((r, i) => (
                  <div key={r.socketId} className="p-3 rounded-xl bg-white/5">
                    User {i + 1}
                  </div>
                ))}
              </div>
            )}

            {activePanel === "chat" && (
              <>
                <div className="flex-1 overflow-auto p-4 space-y-3">
                  {chatMessages.map((msg, i) => (
                    <div key={i}>
                      <div className="text-xs text-gray-400">{msg.from}</div>

                      <div className="bg-white/10 rounded-xl p-3 mt-1">
                        {msg.text}
                      </div>
                    </div>
                  ))}

                  <div ref={chatEndRef} />
                </div>

                <div className="p-4 border-t border-gray-700 flex gap-2">
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendChat()}
                    placeholder="Send a message"
                    className="flex-1 rounded-xl bg-white/10 p-3 outline-none"
                  />

                  <button
                    onClick={sendChat}
                    className="bg-blue-600 px-4 rounded-xl"
                  >
                    Send
                  </button>
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      {/* ── Footer Controls ── */}
      <footer
        className="
  fixed
  bottom-6
  left-1/2
  -translate-x-1/2
  bg-[#202124]
  px-6
  py-3
  rounded-full
  shadow-2xl
  flex
  gap-3
  z-50
  border
  border-white/10
"
      >
        <button
          onClick={toggleMic}
          className={`w-12 h-12 rounded-full ${
            isMicOn ? "bg-white/10" : "bg-red-600"
          }`}
        >
          {isMicOn ? "🎤" : "🔇"}
        </button>

        <button
          onClick={toggleVideo}
          className={`w-12 h-12 rounded-full ${
            isVideoOn ? "bg-white/10" : "bg-red-600"
          }`}
        >
          {isVideoOn ? "📹" : "🚫"}
        </button>

        <button
          onClick={toggleScreen}
          className={`w-12 h-12 rounded-full ${
            isSharingScreen ? "bg-blue-600" : "bg-white/10"
          }`}
        >
          🖥
        </button>

        <button
          onClick={() =>
            setActivePanel((p) =>
              p === "participants" ? null : "participants"
            )
          }
          className="w-12 h-12 rounded-full bg-white/10"
        >
          👥
        </button>

        <button
          onClick={() => setActivePanel((p) => (p === "chat" ? null : "chat"))}
          className="w-12 h-12 rounded-full bg-white/10 relative"
        >
          💬
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {unreadCount}
            </span>
          )}
        </button>

        <button
          onClick={leaveCall}
          className="w-14 h-14 rounded-full bg-red-600"
        >
          📞
        </button>
      </footer>
    </div>
  );
}

export default Room;

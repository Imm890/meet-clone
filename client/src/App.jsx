import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import { Device } from "mediasoup-client";

const socket = io("http://localhost:3001");

function App() {
  const localVideoRef = useRef(null);
  const streamRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);

  const [serverStatus, setServerStatus] = useState("Connecting...");
  const [videoSentToServer, setVideoSentToServer] = useState(false);

  const [remoteStreams, setRemoteStreams] = useState([]);

  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  const setupMediasoup = async () => {
    if (deviceRef.current) return;

    try {
      setServerStatus("Setting up Mediasoup...");
      const device = new Device();
      deviceRef.current = device;

      socket.emit("getRouterRtpCapabilities", {}, async (response) => {
        await device.load({
          routerRtpCapabilities: response.routerRtpCapabilities,
        });
        setServerStatus("Mediasoup Device Ready");

        // 1. Create Send Transport
        socket.emit("createWebRtcTransport", {}, async (transportOptions) => {
          const sendTransport = device.createSendTransport(transportOptions);
          sendTransportRef.current = sendTransport;

          sendTransport.on("connect", ({ dtlsParameters }, callback) => {
            // Pass transportId!
            socket.emit(
              "connectTransport",
              { dtlsParameters, transportId: sendTransport.id },
              () => callback()
            );
          });

          sendTransport.on("produce", ({ kind, rtpParameters }, callback) => {
            // Pass transportId!
            socket.emit(
              "transportProduce",
              { kind, rtpParameters, transportId: sendTransport.id },
              ({ id }) => {
                callback({ id });
                setVideoSentToServer(true);
              }
            );
          });

          if (streamRef.current) {
            const videoTrack = streamRef.current.getVideoTracks()[0];
            const audioTrack = streamRef.current.getAudioTracks()[0];

            if (videoTrack) sendTransport.produce({ track: videoTrack });
            if (audioTrack) sendTransport.produce({ track: audioTrack }); // Send Audio too!
          }
        });

        // 2. Create Receive Transport
        socket.emit("createWebRtcTransport", {}, async (transportOptions) => {
          const recvTransport = device.createRecvTransport(transportOptions);
          recvTransportRef.current = recvTransport;

          recvTransport.on("connect", ({ dtlsParameters }, callback) => {
            // Pass transportId!
            socket.emit(
              "connectTransport",
              { dtlsParameters, transportId: recvTransport.id },
              () => callback()
            );
          });
        });
      });
    } catch (err) {
      console.error("Mediasoup setup error:", err);
    }
  };

  // Listen for new producers
  useEffect(() => {
    socket.on("newProducer", async ({ producerId }) => {
      console.log("New producer detected! Consuming...", producerId);

      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;

      // Pass transportId!
      socket.emit(
        "consume",
        {
          rtpCapabilities: device.rtpCapabilities,
          producerId: producerId,
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
          setRemoteStreams((prev) => [...prev, newStream]);
        }
      );
    });
  }, []);

  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((currentStream) => {
        setStream(currentStream);
        streamRef.current = currentStream;
        if (localVideoRef.current)
          localVideoRef.current.srcObject = currentStream;
        if (socket.connected) setupMediasoup();
      })
      .catch((err) => console.error("Error accessing camera/mic:", err));
  }, []);

  useEffect(() => {
    const handleConnect = () => {
      setServerStatus("Connected to Server");
      if (streamRef.current) setupMediasoup();
    };
    if (socket.connected) handleConnect();
    else socket.on("connect", handleConnect);
    return () => {
      socket.off("connect", handleConnect);
    };
  }, []);

  const toggleMic = () => {
    stream
      .getAudioTracks()
      .forEach((track) => (track.enabled = !track.enabled));
    setIsMicOn((prev) => !prev);
  };

  const toggleVideo = () => {
    stream
      .getVideoTracks()
      .forEach((track) => (track.enabled = !track.enabled));
    setIsVideoOn((prev) => !prev);
  };

  return (
    <div className="h-screen flex flex-col bg-[#1f1f1f] text-white">
      <header className="flex justify-between items-center p-4 bg-[#1a1a1a] border-b border-gray-800">
        <h1 className="text-xl font-semibold">Meet Clone</h1>
        <div className="flex flex-col items-end text-sm">
          <span className="text-green-400">{serverStatus}</span>
          {videoSentToServer && (
            <span className="text-blue-400">📡 Sending Video</span>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-wrap items-center justify-center gap-4 p-6 overflow-hidden">
        <div className="relative bg-black rounded-xl overflow-hidden shadow-lg w-full max-w-md aspect-video flex items-center justify-center">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover ${
              isVideoOn ? "" : "hidden"
            }`}
          />
          {!isVideoOn && (
            <div className="flex items-center justify-center w-full h-full">
              <div className="w-24 h-24 bg-gray-600 rounded-full flex items-center justify-center text-4xl font-bold">
                U
              </div>
            </div>
          )}
          <div className="absolute bottom-3 left-3 bg-black/50 px-3 py-1 rounded-md text-sm">
            You
          </div>
        </div>

        {remoteStreams.map((remoteStream, index) => (
          <div
            key={index}
            className="relative bg-black rounded-xl overflow-hidden shadow-lg w-full max-w-md aspect-video flex items-center justify-center"
          >
            <video
              autoPlay
              playsInline
              ref={(el) => {
                if (el) el.srcObject = remoteStream;
              }}
              className="w-full h-full object-cover"
            />
            <div className="absolute bottom-3 left-3 bg-black/50 px-3 py-1 rounded-md text-sm">
              User {index + 1}
            </div>
          </div>
        ))}
      </main>

      <footer className="flex justify-center items-center gap-4 p-5 bg-[#1a1a1a] border-t border-gray-800">
        <button
          onClick={toggleMic}
          className={`px-5 py-3 rounded-full ${
            isMicOn
              ? "bg-gray-700 hover:bg-gray-600"
              : "bg-red-600 hover:bg-red-500"
          }`}
        >
          {isMicOn ? "🎤 Mic On" : "🚫 Mic Off"}
        </button>
        <button
          onClick={toggleVideo}
          className={`px-5 py-3 rounded-full ${
            isVideoOn
              ? "bg-gray-700 hover:bg-gray-600"
              : "bg-red-600 hover:bg-red-500"
          }`}
        >
          {isVideoOn ? "📹 Video On" : "🚫 Video Off"}
        </button>
        <button className="px-6 py-3 rounded-full bg-red-600 hover:bg-red-500 font-semibold">
          📞 Leave
        </button>
      </footer>
    </div>
  );
}

export default App;

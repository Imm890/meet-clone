// client/src/Home.jsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";

function Home() {
  const [roomId, setRoomId] = useState("");
  const navigate = useNavigate();

  const joinRoom = (e) => {
    e.preventDefault();
    if (roomId.trim()) {
      navigate(`/room/${roomId}`);
    }
  };

  return (
    <div className="h-screen flex flex-col items-center justify-center bg-[#1f1f1f] text-white gap-6">
      <h1 className="text-4xl font-bold">Meet Clone</h1>
      <p className="text-gray-400">Enter a Room ID to start a meeting</p>
      <form onSubmit={joinRoom} className="flex gap-4">
        <input
          type="text"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="e.g. 12345"
          className="px-5 py-3 rounded-full bg-[#2a2a2a] text-white border border-gray-600 focus:outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          className="px-6 py-3 rounded-full bg-blue-600 hover:bg-blue-500 font-semibold"
        >
          Join Meeting
        </button>
      </form>
    </div>
  );
}

export default Home;

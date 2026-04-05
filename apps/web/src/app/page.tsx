"use client";

import { useState, useEffect, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import ChatPanel from "@/components/ChatPanel";

interface Room {
  id: string;
  name: string;
  autoReply?: boolean;
}

export default function Home() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  const refreshRooms = useCallback(async () => {
    const res = await fetch("/api/rooms");
    if (!res.ok) return;
    const data = await res.json();
    setRooms(data);
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/rooms");
      if (!res.ok) return;
      const data = await res.json();
      setRooms(data);
      if (data.length > 0) {
        setActiveRoomId(data[0].id);
      }
    })();
  }, []);

  const handleRoomCreated = (room: Room) => {
    setRooms((prev) => [...prev, room]);
    setActiveRoomId(room.id);
  };

  const handleRoomRemoved = (id: string) => {
    setRooms((prev) => prev.filter((r) => r.id !== id));
    if (activeRoomId === id) setActiveRoomId(null);
  };

  const handleRoomUpdated = (room: Room) => {
    setRooms((prev) => prev.map((r) => (r.id === room.id ? room : r)));
  };

  const handleChatComplete = useCallback(() => {
    setTimeout(refreshRooms, 2000);
  }, [refreshRooms]);

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  return (
    <main className="flex h-screen overflow-hidden">
      <Sidebar
        rooms={rooms}
        activeRoomId={activeRoomId}
        onSelectRoom={setActiveRoomId}
        onRoomCreated={handleRoomCreated}
        onRoomRemoved={handleRoomRemoved}
        onRoomUpdated={handleRoomUpdated}
      />
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-base font-semibold">
          {activeRoom ? activeRoom.name : "Select a room"}
        </div>
        {activeRoomId ? (
          <ChatPanel
            key={activeRoomId}
            roomId={activeRoomId}
            onChatComplete={handleChatComplete}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-dim">
            Create or select a room to start chatting.
          </div>
        )}
      </div>
    </main>
  );
}

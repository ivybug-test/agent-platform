"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import ChatPanel from "@/components/ChatPanel";

interface Room {
  id: string;
  name: string;
  autoReply?: boolean;
}

export default function Home() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  if (status === "loading") {
    return (
      <main className="flex h-screen items-center justify-center" data-theme="dark">
        <span className="loading loading-spinner loading-lg"></span>
      </main>
    );
  }

  if (!session) return null;
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);

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
        setShowSidebar(false);
      }
    })();
  }, []);

  const handleRoomCreated = (room: Room) => {
    setRooms((prev) => [...prev, room]);
    setActiveRoomId(room.id);
    setShowSidebar(false);
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

  const handleSelectRoom = (id: string) => {
    setActiveRoomId(id);
    setShowSidebar(false);
  };

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  return (
    <main className="flex h-screen overflow-hidden" data-theme="dark">
      <div className={`${showSidebar ? "flex" : "hidden"} w-full md:w-auto shrink-0`}>
        <Sidebar
          rooms={rooms}
          activeRoomId={activeRoomId}
          onSelectRoom={handleSelectRoom}
          onRoomCreated={handleRoomCreated}
          onRoomRemoved={handleRoomRemoved}
          onRoomUpdated={handleRoomUpdated}
        />
      </div>

      <div className={`${showSidebar ? "hidden" : "flex"} flex-1 flex-col min-w-0 min-h-0 h-screen overflow-hidden bg-base-100`}>
        <div className="h-12 min-h-12 flex items-center px-3 border-b border-base-300 bg-base-100">
          <button
            className="btn btn-ghost btn-sm mr-2"
            onClick={() => setShowSidebar(!showSidebar)}
          >
            ☰
          </button>
          <span className="text-sm font-semibold truncate">
            {activeRoom ? activeRoom.name : "Select a room"}
          </span>
        </div>
        {activeRoomId ? (
          <ChatPanel
            key={activeRoomId}
            roomId={activeRoomId}
            onChatComplete={handleChatComplete}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
            Create or select a room to start chatting.
          </div>
        )}
      </div>
    </main>
  );
}

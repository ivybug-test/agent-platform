"use client";

import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import FriendsPanel from "./FriendsPanel";

interface Room {
  id: string;
  name: string;
  autoReply?: boolean;
}

interface SidebarProps {
  rooms: Room[];
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
  onRoomCreated: (room: Room) => void;
  onRoomRemoved: (id: string) => void;
  onRoomUpdated: (room: Room) => void;
}

export default function Sidebar({
  rooms,
  activeRoomId,
  onSelectRoom,
  onRoomCreated,
  onRoomRemoved,
  onRoomUpdated,
}: SidebarProps) {
  const { data: session } = useSession();
  const [creating, setCreating] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [menuRoomId, setMenuRoomId] = useState<string | null>(null);

  const archiveRoom = async (id: string) => {
    await fetch(`/api/rooms/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
    });
    setMenuRoomId(null);
    onRoomRemoved(id);
  };

  const deleteRoom = async (id: string) => {
    if (!confirm("Delete this room and all its messages? This cannot be undone.")) return;
    await fetch(`/api/rooms/${id}`, { method: "DELETE" });
    setMenuRoomId(null);
    onRoomRemoved(id);
  };

  const toggleAutoReply = async (room: Room) => {
    const res = await fetch(`/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggleAutoReply" }),
    });
    if (res.ok) {
      const { autoReply } = await res.json();
      onRoomUpdated({ ...room, autoReply });
    }
    setMenuRoomId(null);
  };

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/friends");
      if (!res.ok) return;
      const data = await res.json();
      setPendingCount(data.filter((f: any) => f.direction === "incoming").length);
    })();
  }, [showFriends]);

  const createRoom = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (res.ok) {
        const room = await res.json();
        onRoomCreated(room);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="w-[220px] shrink-0 h-screen overflow-hidden border-r border-border flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
          Rooms
        </h2>
        <button
          className="px-2.5 py-1 rounded bg-primary text-white text-xs cursor-pointer"
          onClick={createRoom}
          disabled={creating}
        >
          + New
        </button>
      </div>

      {/* Room list */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-0.5">
        {rooms.map((room) => (
          <div key={room.id} className="flex items-center mx-1">
            <button
              onClick={() => onSelectRoom(room.id)}
              className={`flex-1 px-3 py-2 text-sm text-left text-white rounded cursor-pointer truncate border-none ${
                room.id === activeRoomId ? "bg-bg-tertiary" : "bg-transparent hover:bg-bg-secondary"
              }`}
            >
              {room.name}
            </button>
            <div className="relative">
              <button
                className="px-1.5 py-1 text-text-dim text-sm bg-transparent border-none cursor-pointer rounded hover:text-text-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuRoomId(menuRoomId === room.id ? null : room.id);
                }}
              >
                ···
              </button>
              {menuRoomId === room.id && (
                <div className="absolute right-0 top-full bg-bg-secondary border border-border rounded-md p-1 z-50 min-w-[120px]">
                  <button
                    className="block w-full px-2.5 py-1.5 text-xs text-left text-text-muted bg-transparent border-none cursor-pointer rounded hover:bg-bg-tertiary"
                    onClick={() => toggleAutoReply(room)}
                  >
                    Auto-reply: {room.autoReply !== false ? "ON" : "OFF"}
                  </button>
                  <button
                    className="block w-full px-2.5 py-1.5 text-xs text-left text-text-muted bg-transparent border-none cursor-pointer rounded hover:bg-bg-tertiary"
                    onClick={() => archiveRoom(room.id)}
                  >
                    Archive
                  </button>
                  <button
                    className="block w-full px-2.5 py-1.5 text-xs text-left text-danger bg-transparent border-none cursor-pointer rounded hover:bg-bg-tertiary"
                    onClick={() => deleteRoom(room.id)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* User bar */}
      {session?.user && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border">
          <span className="text-xs text-text-muted truncate">{session.user.name}</span>
          <div className="flex gap-1 shrink-0">
            <button
              className="px-2 py-1 rounded border border-border bg-transparent text-primary text-xs cursor-pointer"
              onClick={() => setShowFriends(true)}
            >
              Friends{pendingCount > 0 && ` (${pendingCount})`}
            </button>
            <button
              className="px-2 py-1 rounded border border-border bg-transparent text-text-muted text-xs cursor-pointer"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              Logout
            </button>
          </div>
        </div>
      )}
      {showFriends && <FriendsPanel onClose={() => setShowFriends(false)} />}
    </div>
  );
}

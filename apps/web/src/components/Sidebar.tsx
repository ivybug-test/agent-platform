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
    if (!confirm("Delete this room and all its messages?")) return;
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
      if (res.ok) onRoomCreated(await res.json());
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="w-full md:w-[260px] shrink-0 h-screen overflow-hidden border-r border-base-300 flex flex-col bg-base-200" data-theme="dark">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-bold tracking-wide uppercase text-base-content/50">
          Rooms
        </h2>
        <button className="btn btn-primary btn-xs" onClick={createRoom} disabled={creating}>
          + New
        </button>
      </div>

      {/* Room list */}
      <ul className="menu menu-sm flex-1 overflow-y-auto gap-0.5 px-2">
        {rooms.map((room) => (
          <li key={room.id}>
            <div
              className={`flex items-center justify-between pr-1 ${
                room.id === activeRoomId ? "active" : ""
              }`}
            >
              <span className="truncate flex-1" onClick={() => onSelectRoom(room.id)}>
                {room.name}
              </span>
              <div className="dropdown dropdown-end">
                <button
                  tabIndex={0}
                  className="btn btn-ghost btn-xs text-base-content/40 px-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuRoomId(menuRoomId === room.id ? null : room.id);
                  }}
                >
                  ···
                </button>
                {menuRoomId === room.id && (
                  <ul
                    tabIndex={0}
                    className="dropdown-content menu bg-base-300 rounded-box z-50 w-36 p-1 shadow-lg"
                  >
                    <li>
                      <a onClick={() => toggleAutoReply(room)} className="text-xs">
                        Auto-reply: {room.autoReply !== false ? "ON" : "OFF"}
                      </a>
                    </li>
                    <li>
                      <a onClick={() => archiveRoom(room.id)} className="text-xs">
                        Archive
                      </a>
                    </li>
                    <li>
                      <a onClick={() => deleteRoom(room.id)} className="text-xs text-error">
                        Delete
                      </a>
                    </li>
                  </ul>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* User bar */}
      {session?.user && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-base-300">
          <span className="text-xs text-base-content/50 truncate">
            {session.user.name}
          </span>
          <div className="flex gap-1">
            <button
              className="btn btn-ghost btn-xs text-primary"
              onClick={() => setShowFriends(true)}
            >
              Friends{pendingCount > 0 && (
                <span className="badge badge-primary badge-xs ml-1">{pendingCount}</span>
              )}
            </button>
            <button
              className="btn btn-ghost btn-xs text-base-content/40"
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

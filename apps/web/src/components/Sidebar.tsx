"use client";

import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import FriendsPanel from "./FriendsPanel";
import AnnouncementPanel from "./AnnouncementPanel";
import RoomSettings from "./RoomSettings";

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
  const [settingsRoom, setSettingsRoom] = useState<Room | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // Check admin status on load
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/invite");
      setIsAdmin(res.ok);
    })();
  }, []);

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
    if (!confirm("删除该房间及其所有消息?")) return;
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
    <div className="w-72 lg:w-[260px] min-h-full overflow-hidden border-r border-base-300 flex flex-col bg-base-200" data-theme="dark">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-bold tracking-wide text-base-content/50">
          房间
        </h2>
        <button className="btn btn-primary btn-xs" onClick={createRoom} disabled={creating}>
          + 新建
        </button>
      </div>

      {/* Room list */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
        {rooms.map((room) => (
          <div
            key={room.id}
            className={`group flex items-center rounded-lg cursor-pointer transition-colors ${
              room.id === activeRoomId
                ? "bg-primary/20 text-primary-content"
                : "hover:bg-base-300"
            }`}
          >
            <button
              className="flex-1 text-left text-sm truncate px-3 py-2 min-w-0"
              onClick={() => onSelectRoom(room.id)}
            >
              {room.name}
            </button>
            <div className="relative">
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity btn btn-ghost btn-xs btn-square text-base-content/50 mr-1"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuRoomId(menuRoomId === room.id ? null : room.id);
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="w-4 h-4" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
                </svg>
              </button>
              {menuRoomId === room.id && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuRoomId(null)} />
                  <ul className="absolute right-0 top-full mt-1 z-50 menu bg-base-300 rounded-lg shadow-xl w-40 p-1">
                    <li>
                      <button onClick={() => toggleAutoReply(room)} className="text-xs rounded-md">
                        自动回复: {room.autoReply !== false ? "开" : "关"}
                      </button>
                    </li>
                    <li>
                      <button
                        onClick={() => {
                          setSettingsRoom(room);
                          setMenuRoomId(null);
                        }}
                        className="text-xs rounded-md"
                      >
                        房间共享事实
                      </button>
                    </li>
                    <li>
                      <button onClick={() => archiveRoom(room.id)} className="text-xs rounded-md">
                        归档
                      </button>
                    </li>
                    <li>
                      <button onClick={() => deleteRoom(room.id)} className="text-xs text-error rounded-md">
                        删除
                      </button>
                    </li>
                  </ul>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Announcement (collapsible, auto-hides after 3 days) */}
      <AnnouncementPanel />

      {/* User bar */}
      {session?.user && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-base-300">
          <span className="text-xs text-base-content/50 truncate">
            {session.user.name}
          </span>
          <div className="flex gap-1">
            {isAdmin && (
              <button
                className="btn btn-ghost btn-xs text-warning"
                onClick={async () => {
                  const res = await fetch("/api/invite", { method: "POST" });
                  if (res.ok) {
                    const { code } = await res.json();
                    const url = `${window.location.origin}/register?code=${code}`;
                    try { await navigator.clipboard.writeText(url); } catch {}
                    window.prompt("邀请链接(复制后发送):", url);
                  }
                }}
              >
                邀请
              </button>
            )}
            <a
              className="btn btn-ghost btn-xs text-info"
              href="/memories"
            >
              记忆
            </a>
            <button
              className="btn btn-ghost btn-xs text-primary"
              onClick={() => setShowFriends(true)}
            >
              好友{pendingCount > 0 && (
                <span className="badge badge-primary badge-xs ml-1">{pendingCount}</span>
              )}
            </button>
            <button
              className="btn btn-ghost btn-xs text-base-content/40"
              onClick={() => signOut({ redirect: false }).then(() => window.location.href = "/login")}
            >
              退出
            </button>
          </div>
        </div>
      )}
      {showFriends && <FriendsPanel onClose={() => setShowFriends(false)} />}
      {settingsRoom && (
        <RoomSettings
          roomId={settingsRoom.id}
          roomName={settingsRoom.name}
          onClose={() => setSettingsRoom(null)}
        />
      )}
    </div>
  );
}

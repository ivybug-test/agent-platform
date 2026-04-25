"use client";

import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import RoomSettings from "./RoomSettings";

interface Room {
  id: string;
  name: string;
  autoReply?: boolean;
}

// FLIP animation parameters — tweak these if the reorder feels too fast/slow.
const FLIP_DURATION_MS = 260;
const FLIP_EASING = "cubic-bezier(0.4, 0.0, 0.2, 1)";

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
  const [pendingCount, setPendingCount] = useState(0);
  const [menuRoomId, setMenuRoomId] = useState<string | null>(null);
  const [settingsRoom, setSettingsRoom] = useState<Room | null>(null);

  // FLIP animation on reorder. We snapshot each row's top offset before the
  // rooms prop triggers a re-render; after layout, we measure the new offsets
  // and, for any row that moved, apply an inverting translateY + transition
  // it back to zero. Plain DOM — no animation lib.
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const prevOffsets = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const newOffsets = new Map<string, number>();
    for (const [id, el] of rowRefs.current) {
      if (el) newOffsets.set(id, el.offsetTop);
    }

    for (const [id, el] of rowRefs.current) {
      if (!el) continue;
      const prev = prevOffsets.current.get(id);
      const curr = newOffsets.get(id);
      if (prev === undefined || curr === undefined || prev === curr) continue;

      const delta = prev - curr;
      // Jump back to old spot without animation...
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
      // ...then on the next frame, transition back to zero.
      requestAnimationFrame(() => {
        el.style.transition = `transform ${FLIP_DURATION_MS}ms ${FLIP_EASING}`;
        el.style.transform = "translateY(0)";
      });
    }

    prevOffsets.current = newOffsets;
  }, [rooms]);

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

  // Pending-friend badge dot on the "我的" gear icon. Polled on mount;
  // detailed friend management lives on /me now.
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/friends");
      if (!res.ok) return;
      const data = await res.json();
      setPendingCount(data.filter((f: any) => f.direction === "incoming").length);
    })();
  }, []);

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
            ref={(el) => {
              if (el) rowRefs.current.set(room.id, el);
              else rowRefs.current.delete(room.id);
            }}
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

      {/* User bar — collapsed to user name + gear (→ /me) + logout.
          Detailed entries (邀请 / 记忆 / 好友 / 最近更新) all live on
          /me to keep this strip uncluttered. Pending-friends badge shows
          here as a small red dot on the gear so the user notices. */}
      {session?.user && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-base-300">
          <span className="text-xs text-base-content/50 truncate">
            {session.user.name}
          </span>
          <div className="flex gap-0.5">
            <a
              className="btn btn-ghost btn-xs btn-square relative"
              href="/me"
              title="我的"
              aria-label="我的"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                strokeWidth={1.8}
                stroke="currentColor"
                className="w-4 h-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.78.93l-.15.893c-.09.543-.56.94-1.11.94h-1.094c-.55 0-1.019-.397-1.11-.94l-.149-.894c-.07-.424-.383-.764-.78-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.273-.807.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.764-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.93l.15-.894Z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
              {pendingCount > 0 && (
                <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-error" />
              )}
            </a>
            <button
              className="btn btn-ghost btn-xs btn-square text-base-content/40"
              onClick={() => signOut({ redirect: false }).then(() => window.location.href = "/login")}
              title="退出"
              aria-label="退出"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                strokeWidth={1.8}
                stroke="currentColor"
                className="w-4 h-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75"
                />
              </svg>
            </button>
          </div>
        </div>
      )}
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

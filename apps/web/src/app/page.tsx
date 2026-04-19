"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { io, Socket } from "socket.io-client";
import Sidebar from "@/components/Sidebar";
import ChatPanel from "@/components/ChatPanel";

interface Room {
  id: string;
  name: string;
  autoReply?: boolean;
  lastActivityAt?: string;
}

/** Sort rooms by lastActivityAt DESC so the most recently-active room is
 *  always at the top. Rooms with no activity fall back to createdAt. */
function sortRooms(list: Room[]): Room[] {
  return [...list].sort((a, b) => {
    const ta = new Date(a.lastActivityAt || 0).getTime();
    const tb = new Date(b.lastActivityAt || 0).getTime();
    return tb - ta;
  });
}

export default function Home() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const drawerRef = useRef<HTMLInputElement>(null);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  // Swipe right from left edge to open drawer
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = Math.abs(e.changedTouches[0].clientY - startY);
      // Swipe right from left 30px edge, horizontal movement > 60px, not too vertical
      if (startX < 30 && dx > 60 && dy < 100 && drawerRef.current) {
        drawerRef.current.checked = true;
      }
    };
    document.addEventListener("touchstart", onTouchStart);
    document.addEventListener("touchend", onTouchEnd);
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  const refreshRooms = useCallback(async () => {
    const res = await fetch("/api/rooms");
    if (!res.ok) return;
    setRooms(sortRooms(await res.json()));
  }, []);

  const currentUserId = session?.user?.id;

  useEffect(() => {
    if (status !== "authenticated" || !currentUserId) return;
    (async () => {
      const res = await fetch("/api/rooms");
      if (!res.ok) return;
      const data = sortRooms(await res.json());
      setRooms(data);
      if (data.length > 0) {
        const key = `lastRoomId:${currentUserId}`;
        const lastId = localStorage.getItem(key);
        const found = lastId && data.some((r: Room) => r.id === lastId);
        setActiveRoomId(found ? lastId : data[0].id);
      }
    })();
  }, [status, currentUserId]);

  // Persist activeRoomId whenever it changes
  useEffect(() => {
    if (activeRoomId && currentUserId) {
      try { localStorage.setItem(`lastRoomId:${currentUserId}`, activeRoomId); } catch {}
    }
  }, [activeRoomId, currentUserId]);

  const closeDrawer = () => {
    if (drawerRef.current) drawerRef.current.checked = false;
  };

  const handleSelectRoom = (id: string) => {
    setActiveRoomId(id);
    closeDrawer();
  };

  const handleRoomCreated = (room: Room) => {
    // New rooms carry no lastActivityAt yet; stamp one so they sort at the top.
    const stamped = { ...room, lastActivityAt: new Date().toISOString() };
    setRooms((prev) => sortRooms([...prev, stamped]));
    setActiveRoomId(room.id);
    closeDrawer();
  };

  const handleRoomRemoved = (id: string) => {
    setRooms((prev) => prev.filter((r) => r.id !== id));
    if (activeRoomId === id) setActiveRoomId(null);
  };

  const handleRoomUpdated = (room: Room) => {
    setRooms((prev) => prev.map((r) => (r.id === room.id ? { ...r, ...room } : r)));
  };

  const handleChatComplete = useCallback(() => {
    setTimeout(refreshRooms, 2000);
  }, [refreshRooms]);

  // Listen for user-level events (new rooms, etc.) via Socket.IO
  useEffect(() => {
    const userId = session?.user?.id;
    const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
    if (!userId || !gatewayUrl || status !== "authenticated") return;

    const socket: Socket = io(gatewayUrl);

    socket.on("connect", () => {
      socket.emit("register-user", userId);
    });

    socket.on("user-event", (event: any) => {
      if (event.type === "room-added" && event.room) {
        setRooms((prev) => {
          if (prev.some((r) => r.id === event.room.id)) return prev;
          return sortRooms([
            ...prev,
            { ...event.room, lastActivityAt: new Date().toISOString() },
          ]);
        });
      } else if (event.type === "room-removed" && event.roomId) {
        setRooms((prev) => prev.filter((r) => r.id !== event.roomId));
        setActiveRoomId((cur) => (cur === event.roomId ? null : cur));
      } else if (event.type === "room-updated" && event.room) {
        setRooms((prev) =>
          sortRooms(
            prev.map((r) => (r.id === event.room.id ? { ...r, ...event.room } : r))
          )
        );
      } else if (event.type === "room-activity" && event.roomId && event.at) {
        setRooms((prev) =>
          sortRooms(
            prev.map((r) =>
              r.id === event.roomId ? { ...r, lastActivityAt: event.at } : r
            )
          )
        );
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [session?.user?.id, status]);

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  if (status === "loading") {
    return (
      <main className="flex h-screen items-center justify-center" data-theme="dark">
        <span className="loading loading-spinner loading-lg"></span>
      </main>
    );
  }

  if (!session) return null;

  return (
    <div className="drawer lg:drawer-open" style={{ height: "100dvh" }} data-theme="dark">
      <input ref={drawerRef} id="sidebar-drawer" type="checkbox" className="drawer-toggle" />

      {/* Main content */}
      <div className="drawer-content flex flex-col overflow-hidden" style={{ height: "100dvh" }}>
        {/* Top bar with hamburger — sticky so it never scrolls away */}
        <div className="sticky top-0 z-10 h-12 min-h-12 flex items-center px-3 border-b border-base-300 bg-base-100">
          <label htmlFor="sidebar-drawer" className="btn btn-ghost btn-sm btn-square lg:hidden mr-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="w-5 h-5 stroke-current">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </label>
          <span className="text-sm font-semibold truncate">
            {activeRoom ? activeRoom.name : "选择房间"}
          </span>
        </div>

        {/* Chat area */}
        {activeRoomId ? (
          <ChatPanel
            key={activeRoomId}
            roomId={activeRoomId}
            onChatComplete={handleChatComplete}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
            创建或选择一个房间开始聊天。
          </div>
        )}
      </div>

      {/* Sidebar drawer */}
      <div className="drawer-side z-50" data-theme="dark">
        <label htmlFor="sidebar-drawer" aria-label="关闭侧边栏" className="drawer-overlay !bg-black/50"></label>
        <Sidebar
          rooms={rooms}
          activeRoomId={activeRoomId}
          onSelectRoom={handleSelectRoom}
          onRoomCreated={handleRoomCreated}
          onRoomRemoved={handleRoomRemoved}
          onRoomUpdated={handleRoomUpdated}
        />
      </div>
    </div>
  );
}

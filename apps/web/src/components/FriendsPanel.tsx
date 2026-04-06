"use client";

import { useState, useEffect } from "react";

interface Friend {
  id: string;
  status: string;
  direction: string;
  friend: { id: string; name: string; email: string };
}

export default function FriendsPanel({ onClose }: { onClose: () => void }) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const loadFriends = async () => {
    const res = await fetch("/api/friends");
    if (res.ok) setFriends(await res.json());
  };

  useEffect(() => {
    loadFriends();
  }, []);

  const sendRequest = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/friends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();
      if (res.ok) {
        setEmail("");
        setMessage("Request sent!");
        loadFriends();
      } else {
        setMessage(data.error || "Failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const acceptRequest = async (id: string) => {
    const res = await fetch(`/api/friends/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });
    if (res.ok) loadFriends();
  };

  const removeFriend = async (id: string) => {
    const res = await fetch(`/api/friends/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) loadFriends();
  };

  const incoming = friends.filter((f) => f.direction === "incoming");
  const outgoing = friends.filter((f) => f.direction === "outgoing");
  const accepted = friends.filter((f) => f.direction === "mutual");

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100]" onClick={onClose}>
      <div className="bg-bg-secondary rounded-xl w-[calc(100%-2rem)] max-w-[400px] max-h-[80vh] overflow-y-auto p-4 md:p-5 mx-4" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Friends</h2>
          <button className="bg-transparent border-none text-text-muted text-2xl cursor-pointer" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Add friend */}
        <div className="mb-4">
          <div className="flex gap-2">
            <input
              className="flex-1 px-2.5 py-2 rounded-md border border-border bg-bg text-white text-sm outline-none"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendRequest()}
              placeholder="Add by email..."
              disabled={loading}
            />
            <button
              className="px-3.5 py-2 rounded-md bg-primary text-white text-sm cursor-pointer disabled:opacity-50"
              onClick={sendRequest}
              disabled={loading || !email.trim()}
            >
              Add
            </button>
          </div>
          {message && <p className="text-xs text-primary mt-1.5">{message}</p>}
        </div>

        {/* Incoming */}
        {incoming.length > 0 && (
          <div className="mb-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Pending Requests
            </h3>
            {incoming.map((f) => (
              <div key={f.id} className="flex justify-between items-center py-1.5 border-b border-border/50">
                <span className="text-sm">
                  {f.friend.name}{" "}
                  <span className="text-xs text-text-dim">{f.friend.email}</span>
                </span>
                <div className="flex gap-1">
                  <button
                    className="px-2.5 py-1 rounded bg-primary text-white text-xs cursor-pointer"
                    onClick={() => acceptRequest(f.id)}
                  >
                    Accept
                  </button>
                  <button
                    className="px-2.5 py-1 rounded border border-border bg-transparent text-text-muted text-xs cursor-pointer"
                    onClick={() => removeFriend(f.id)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Outgoing */}
        {outgoing.length > 0 && (
          <div className="mb-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Sent Requests
            </h3>
            {outgoing.map((f) => (
              <div key={f.id} className="flex justify-between items-center py-1.5 border-b border-border/50">
                <span className="text-sm">
                  {f.friend.name}{" "}
                  <span className="text-xs text-text-dim">{f.friend.email}</span>
                </span>
                <button
                  className="px-2.5 py-1 rounded border border-border bg-transparent text-text-muted text-xs cursor-pointer"
                  onClick={() => removeFriend(f.id)}
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Accepted */}
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            Friends {accepted.length > 0 && `(${accepted.length})`}
          </h3>
          {accepted.length === 0 && (
            <p className="text-sm text-text-dim">No friends yet. Add someone above!</p>
          )}
          {accepted.map((f) => (
            <div key={f.id} className="flex justify-between items-center py-1.5 border-b border-border/50">
              <span className="text-sm">
                {f.friend.name}{" "}
                <span className="text-xs text-text-dim">{f.friend.email}</span>
              </span>
              <button
                className="px-2.5 py-1 rounded border border-border bg-transparent text-text-muted text-xs cursor-pointer"
                onClick={() => removeFriend(f.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

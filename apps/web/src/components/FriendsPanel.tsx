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

  useEffect(() => { loadFriends(); }, []);

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
      if (res.ok) { setEmail(""); setMessage("Request sent!"); loadFriends(); }
      else setMessage(data.error || "Failed");
    } finally { setLoading(false); }
  };

  const acceptRequest = async (id: string) => {
    await fetch(`/api/friends/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });
    loadFriends();
  };

  const removeFriend = async (id: string) => {
    await fetch(`/api/friends/${id}`, { method: "DELETE" });
    loadFriends();
  };

  const incoming = friends.filter((f) => f.direction === "incoming");
  const outgoing = friends.filter((f) => f.direction === "outgoing");
  const accepted = friends.filter((f) => f.direction === "mutual");

  return (
    <div className="modal modal-open" onClick={onClose}>
      <div className="modal-box w-[calc(100%-2rem)] max-w-md" data-theme="dark" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-lg">Friends</h3>
          <button className="btn btn-sm btn-circle btn-ghost" onClick={onClose}>✕</button>
        </div>

        {/* Add friend */}
        <div className="form-control mb-4">
          <div className="join w-full">
            <input
              className="input input-bordered join-item flex-1 input-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendRequest()}
              placeholder="Add by email..."
              disabled={loading}
            />
            <button
              className="btn btn-primary join-item btn-sm"
              onClick={sendRequest}
              disabled={loading || !email.trim()}
            >
              Add
            </button>
          </div>
          {message && <label className="label"><span className="label-text-alt text-primary">{message}</span></label>}
        </div>

        {/* Incoming */}
        {incoming.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-2">Pending Requests</h4>
            {incoming.map((f) => (
              <div key={f.id} className="flex items-center justify-between py-2 border-b border-base-300">
                <div>
                  <span className="text-sm font-medium">{f.friend.name}</span>
                  <span className="text-xs text-base-content/40 ml-2">{f.friend.email}</span>
                </div>
                <div className="flex gap-1">
                  <button className="btn btn-primary btn-xs" onClick={() => acceptRequest(f.id)}>Accept</button>
                  <button className="btn btn-ghost btn-xs" onClick={() => removeFriend(f.id)}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Outgoing */}
        {outgoing.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-2">Sent Requests</h4>
            {outgoing.map((f) => (
              <div key={f.id} className="flex items-center justify-between py-2 border-b border-base-300">
                <div>
                  <span className="text-sm font-medium">{f.friend.name}</span>
                  <span className="text-xs text-base-content/40 ml-2">{f.friend.email}</span>
                </div>
                <button className="btn btn-ghost btn-xs" onClick={() => removeFriend(f.id)}>Cancel</button>
              </div>
            ))}
          </div>
        )}

        {/* Accepted */}
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-2">
            Friends {accepted.length > 0 && `(${accepted.length})`}
          </h4>
          {accepted.length === 0 && (
            <p className="text-sm text-base-content/30">No friends yet. Add someone above!</p>
          )}
          {accepted.map((f) => (
            <div key={f.id} className="flex items-center justify-between py-2 border-b border-base-300">
              <div>
                <span className="text-sm font-medium">{f.friend.name}</span>
                <span className="text-xs text-base-content/40 ml-2">{f.friend.email}</span>
              </div>
              <button className="btn btn-ghost btn-xs text-error" onClick={() => removeFriend(f.id)}>Remove</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

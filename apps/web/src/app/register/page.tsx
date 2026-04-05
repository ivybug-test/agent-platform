"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Registration failed");
        return;
      }
      router.push("/login");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex h-screen items-center justify-center">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 w-80">
        <h1 className="text-2xl font-semibold text-center mb-2">Register</h1>
        {error && <p className="text-danger text-sm text-center">{error}</p>}
        <input className="px-3 py-2.5 rounded-lg border border-border bg-bg-secondary text-white text-sm outline-none" type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="px-3 py-2.5 rounded-lg border border-border bg-bg-secondary text-white text-sm outline-none" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="px-3 py-2.5 rounded-lg border border-border bg-bg-secondary text-white text-sm outline-none" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={4} />
        <button className="py-2.5 rounded-lg bg-primary text-white text-sm cursor-pointer" type="submit" disabled={loading}>
          {loading ? "Registering..." : "Register"}
        </button>
        <p className="text-xs text-center text-text-muted">
          Already have an account? <a href="/login" className="text-primary no-underline">Register</a>
        </p>
      </form>
    </main>
  );
}

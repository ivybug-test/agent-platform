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
    <main className="flex h-screen items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center mb-4">Create Account</h1>
        {error && <p className="text-danger text-sm text-center">{error}</p>}
        <input className="px-4 py-3 rounded-xl border border-border bg-bg-secondary text-white text-sm outline-none focus:border-primary transition-colors" type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="px-4 py-3 rounded-xl border border-border bg-bg-secondary text-white text-sm outline-none focus:border-primary transition-colors" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="px-4 py-3 rounded-xl border border-border bg-bg-secondary text-white text-sm outline-none focus:border-primary transition-colors" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={4} />
        <button className="py-3 rounded-xl bg-primary text-white text-sm font-medium cursor-pointer active:opacity-80 transition-opacity" type="submit" disabled={loading}>
          {loading ? "Creating account..." : "Register"}
        </button>
        <p className="text-sm text-center text-text-muted mt-2">
          Already have an account? <a href="/login" className="text-primary no-underline">Login</a>
        </p>
      </form>
    </main>
  );
}

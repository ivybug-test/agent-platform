"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
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
      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) { setError("Invalid email or password"); return; }
      router.push("/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex h-screen items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center mb-4">Agent Platform</h1>
        {error && <p className="text-danger text-sm text-center">{error}</p>}
        <input className="px-4 py-3 rounded-xl border border-border bg-bg-secondary text-white text-sm outline-none focus:border-primary transition-colors" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="px-4 py-3 rounded-xl border border-border bg-bg-secondary text-white text-sm outline-none focus:border-primary transition-colors" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="py-3 rounded-xl bg-primary text-white text-sm font-medium cursor-pointer active:opacity-80 transition-opacity" type="submit" disabled={loading}>
          {loading ? "Logging in..." : "Login"}
        </button>
        <p className="text-sm text-center text-text-muted mt-2">
          Don't have an account? <a href="/register" className="text-primary no-underline">Register</a>
        </p>
      </form>
    </main>
  );
}

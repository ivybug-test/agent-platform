"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function RegisterForm() {
  const searchParams = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(searchParams.get("code") || "");
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
        body: JSON.stringify({ name, email, password, inviteCode }),
      });
      if (!res.ok) { setError((await res.json()).error || "Registration failed"); return; }
      router.push("/login");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card w-full max-w-sm bg-base-200 shadow-xl">
      <div className="card-body">
        <h1 className="card-title text-xl justify-center mb-2">Create Account</h1>
        {error && <div className="alert alert-error text-sm py-2">{error}</div>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input className="input input-bordered w-full" type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="input input-bordered w-full" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className="input input-bordered w-full" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={4} />
          <input className="input input-bordered w-full" type="text" placeholder="Invite Code" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required />
          <button className="btn btn-primary w-full" type="submit" disabled={loading}>
            {loading ? <span className="loading loading-spinner loading-sm"></span> : "Register"}
          </button>
        </form>
        <p className="text-sm text-center text-base-content/50 mt-2">
          Already have an account? <a href="/login" className="link link-primary">Login</a>
        </p>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <main className="flex h-screen items-center justify-center px-4" data-theme="dark">
      <Suspense fallback={<span className="loading loading-spinner"></span>}>
        <RegisterForm />
      </Suspense>
    </main>
  );
}

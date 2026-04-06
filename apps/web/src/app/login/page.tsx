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
    <main className="flex h-screen items-center justify-center px-4" data-theme="dark">
      <div className="card w-full max-w-sm bg-base-200 shadow-xl">
        <div className="card-body">
          <h1 className="card-title text-xl justify-center mb-2">Agent Platform</h1>
          {error && <div className="alert alert-error text-sm py-2">{error}</div>}
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input className="input input-bordered w-full" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="input input-bordered w-full" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button className="btn btn-primary w-full" type="submit" disabled={loading}>
              {loading ? <span className="loading loading-spinner loading-sm"></span> : "Login"}
            </button>
          </form>
          <p className="text-sm text-center text-base-content/50 mt-2">
            Don't have an account? <a href="/register" className="link link-primary">Register</a>
          </p>
        </div>
      </div>
    </main>
  );
}

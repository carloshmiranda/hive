"use client";

import { useState } from "react";
import Link from "next/link";

const LAUNCH_MODE = process.env.NEXT_PUBLIC_LAUNCH_MODE || "waitlist";

function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [result, setResult] = useState<{ referral_code?: string; position?: number; already_signed_up?: boolean } | null>(null);

  // Get referral code from URL
  const ref = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("ref") : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name: name || undefined,
          ref: ref || undefined,
          utm_source: new URLSearchParams(window.location.search).get("utm_source") || undefined,
          utm_medium: new URLSearchParams(window.location.search).get("utm_medium") || undefined,
          utm_campaign: new URLSearchParams(window.location.search).get("utm_campaign") || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult(data);
        setState("success");
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }

  if (state === "success" && result) {
    const referralLink = `${window.location.origin}?ref=${result.referral_code}`;
    return (
      <div className="text-center">
        <p className="text-lg font-medium text-gray-900 mb-2">
          {result.already_signed_up ? "You're already on the list!" : "You're in!"}
        </p>
        <p className="text-gray-600 mb-4">
          You're <span className="font-bold">#{result.position}</span> on the waitlist.
        </p>
        <div className="bg-gray-50 rounded-lg p-4 text-sm">
          <p className="text-gray-500 mb-2">Share your link to move up:</p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={referralLink}
              className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded text-gray-700 text-sm"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              onClick={() => navigator.clipboard.writeText(referralLink)}
              className="px-3 py-2 bg-gray-900 text-white rounded text-sm hover:bg-gray-800 transition"
            >
              Copy
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 max-w-md mx-auto">
      <input
        type="text"
        placeholder="Your name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="px-4 py-3 border border-gray-200 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900"
      />
      <div className="flex gap-2">
        <input
          type="email"
          required
          placeholder="your@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 px-4 py-3 border border-gray-200 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        <button
          type="submit"
          disabled={state === "loading"}
          className="px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition disabled:opacity-50"
        >
          {state === "loading" ? "..." : "Join"}
        </button>
      </div>
      {ref && <p className="text-sm text-gray-500">Referred by a friend? You'll get priority access.</p>}
      {state === "error" && <p className="text-sm text-red-500">Something went wrong. Please try again.</p>}
    </form>
  );
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Hero */}
      <header className="max-w-3xl mx-auto px-6 py-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-gray-900 mb-4">
          {"{{COMPANY_NAME}}"}
        </h1>
        <p className="text-lg text-gray-600 mb-8 max-w-xl mx-auto">
          {"{{DESCRIPTION}}"}
        </p>

        {LAUNCH_MODE === "waitlist" && (
          <WaitlistForm />
        )}

        {LAUNCH_MODE === "early_access" && (
          <div className="flex gap-4 justify-center">
            <Link href="/checkout" className="px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition">
              Get early access
            </Link>
            <a href="#features" className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition">
              Learn more
            </a>
          </div>
        )}

        {LAUNCH_MODE === "live" && (
          <div className="flex gap-4 justify-center">
            <Link href="/checkout" className="px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition">
              Get started
            </Link>
            <a href="#features" className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition">
              Learn more
            </a>
          </div>
        )}
      </header>

      {/* Features placeholder */}
      <section id="features" className="max-w-4xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-3 gap-8">
          {["Fast", "Simple", "Reliable"].map((feature, i) => (
            <div key={i} className="p-6 border border-gray-200 rounded-xl">
              <h3 className="font-semibold text-gray-900 mb-2">{feature}</h3>
              <p className="text-sm text-gray-500">Description of this feature and why it matters to the user.</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="max-w-3xl mx-auto px-6 py-12 text-center text-sm text-gray-400">
        {"{{COMPANY_NAME}}"} · Built with care
      </footer>
    </div>
  );
}

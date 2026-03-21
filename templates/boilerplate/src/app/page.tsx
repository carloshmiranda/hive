"use client";

import { useState } from "react";
import Link from "next/link";

const LAUNCH_MODE = process.env.NEXT_PUBLIC_LAUNCH_MODE || "waitlist";

function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [result, setResult] = useState<{ referral_code?: string; position?: number; already_signed_up?: boolean } | null>(null);

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

function CTAButtons() {
  const href = LAUNCH_MODE === "early_access" ? "/checkout" : "/checkout";
  const label = LAUNCH_MODE === "early_access" ? "Get early access" : "Get started";
  return (
    <div className="flex gap-4 justify-center">
      <Link href={href} className="px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition">
        {label}
      </Link>
      <a href="#features" className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition">
        Learn more
      </a>
    </div>
  );
}

/* ─── Template placeholders (replaced by Provisioner) ─── */
const COMPANY_NAME = "{{COMPANY_NAME}}";
const DESCRIPTION = "{{DESCRIPTION}}";
const VALUE_PROPOSITION = "{{VALUE_PROPOSITION}}";

/* Features — Provisioner replaces these with real product features from the Scout proposal */
const FEATURES = [
  {
    icon: "📊",
    title: "{{FEATURE_1_TITLE}}",
    description: "{{FEATURE_1_DESC}}",
  },
  {
    icon: "⚡",
    title: "{{FEATURE_2_TITLE}}",
    description: "{{FEATURE_2_DESC}}",
  },
  {
    icon: "🔒",
    title: "{{FEATURE_3_TITLE}}",
    description: "{{FEATURE_3_DESC}}",
  },
];

/* FAQ — Provisioner replaces with real questions from target audience research */
const FAQS = [
  {
    q: "{{FAQ_1_Q}}",
    a: "{{FAQ_1_A}}",
  },
  {
    q: "{{FAQ_2_Q}}",
    a: "{{FAQ_2_A}}",
  },
  {
    q: "{{FAQ_3_Q}}",
    a: "{{FAQ_3_A}}",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
        <span className="text-lg font-bold text-gray-900">{COMPANY_NAME}</span>
        <div className="flex items-center gap-6 text-sm text-gray-600">
          <a href="#features" className="hover:text-gray-900 transition">Features</a>
          <a href="#how-it-works" className="hover:text-gray-900 transition">How it works</a>
          <a href="#faq" className="hover:text-gray-900 transition">FAQ</a>
        </div>
      </nav>

      {/* Hero */}
      <header id="waitlist" className="max-w-3xl mx-auto px-6 pt-16 pb-20 text-center">
        <div className="inline-block px-3 py-1 mb-6 text-xs font-medium text-gray-600 bg-gray-100 rounded-full">
          Now in early access
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-gray-900 mb-6 leading-tight">
          {DESCRIPTION}
        </h1>
        <p className="text-lg text-gray-500 mb-10 max-w-xl mx-auto leading-relaxed">
          {VALUE_PROPOSITION}
        </p>

        {LAUNCH_MODE === "waitlist" && <WaitlistForm />}
        {LAUNCH_MODE !== "waitlist" && <CTAButtons />}

        <p className="mt-4 text-xs text-gray-400">Free to try. No credit card required.</p>
      </header>

      {/* Product preview */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="bg-gradient-to-b from-gray-50 to-gray-100 rounded-2xl border border-gray-200 p-8 md:p-12">
          <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6 md:p-8">
            <div className="flex items-center gap-2 mb-6">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <div className="w-3 h-3 rounded-full bg-yellow-400" />
              <div className="w-3 h-3 rounded-full bg-green-400" />
              <span className="ml-2 text-xs text-gray-400 font-mono">{COMPANY_NAME.toLowerCase()}.app</span>
            </div>
            <div className="space-y-4">
              <div className="h-8 bg-gray-100 rounded-lg w-2/3" />
              <div className="grid grid-cols-3 gap-4">
                <div className="h-24 bg-gray-50 rounded-lg border border-gray-100" />
                <div className="h-24 bg-gray-50 rounded-lg border border-gray-100" />
                <div className="h-24 bg-gray-50 rounded-lg border border-gray-100" />
              </div>
              <div className="h-32 bg-gray-50 rounded-lg border border-gray-100" />
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-4xl mx-auto px-6 py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-gray-900 mb-4">Everything you need</h2>
          <p className="text-gray-500 max-w-lg mx-auto">
            Built for people who want results, not complexity.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-8">
          {FEATURES.map((feature, i) => (
            <div key={i} className="p-6 rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-sm transition">
              <div className="text-2xl mb-3">{feature.icon}</div>
              <h3 className="font-semibold text-gray-900 mb-2">{feature.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="bg-gray-50 py-20">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">How it works</h2>
            <p className="text-gray-500">Get started in minutes, not hours.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { step: "1", title: "Sign up", desc: "Create your account in seconds. No credit card required." },
              { step: "2", title: "Set up", desc: "Connect your data and configure your preferences." },
              { step: "3", title: "Get results", desc: "Start seeing insights and saving time immediately." },
            ].map((item, i) => (
              <div key={i} className="text-center">
                <div className="w-10 h-10 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold mx-auto mb-4">
                  {item.step}
                </div>
                <h3 className="font-semibold text-gray-900 mb-2">{item.title}</h3>
                <p className="text-sm text-gray-500">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social proof — only shown when real data exists (e.g. waitlist count). Skip entirely for MVP launch. */}

      {/* FAQ */}
      <section id="faq" className="bg-gray-50 py-20">
        <div className="max-w-2xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-gray-900 mb-12 text-center">Frequently asked questions</h2>
          <div className="space-y-6">
            {FAQS.map((faq, i) => (
              <details key={i} className="group bg-white rounded-xl border border-gray-200 px-6 py-4">
                <summary className="cursor-pointer font-medium text-gray-900 flex items-center justify-between">
                  {faq.q}
                  <span className="text-gray-400 group-open:rotate-45 transition-transform text-lg">+</span>
                </summary>
                <p className="mt-3 text-sm text-gray-500 leading-relaxed">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="max-w-3xl mx-auto px-6 py-20 text-center">
        <h2 className="text-3xl font-bold text-gray-900 mb-4">Ready to get started?</h2>
        <p className="text-gray-500 mb-8 max-w-md mx-auto">
          Join hundreds of early adopters who are already saving time.
        </p>
        {LAUNCH_MODE === "waitlist" && <WaitlistForm />}
        {LAUNCH_MODE !== "waitlist" && <CTAButtons />}
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 py-12">
        <div className="max-w-4xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="font-bold text-gray-900">{COMPANY_NAME}</span>
          <div className="flex gap-6 text-sm text-gray-500">
            <a href="#features" className="hover:text-gray-900 transition">Features</a>
            <a href="#how-it-works" className="hover:text-gray-900 transition">How it works</a>
            <a href="#faq" className="hover:text-gray-900 transition">FAQ</a>
          </div>
          <p className="text-sm text-gray-400">&copy; {new Date().getFullYear()} {COMPANY_NAME}</p>
        </div>
      </footer>
    </div>
  );
}

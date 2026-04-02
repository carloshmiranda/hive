"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [result, setResult] = useState<{
    referral_code?: string;
    position?: number;
    already_signed_up?: boolean;
  } | null>(null);

  const ref =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("ref")
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");

    try {
      const params = new URLSearchParams(window.location.search);
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name: name || undefined,
          ref: ref || undefined,
          utm_source: params.get("utm_source") || undefined,
          utm_medium: params.get("utm_medium") || undefined,
          utm_campaign: params.get("utm_campaign") || undefined,
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
        <p className="text-[var(--font-size-lg)] font-medium text-[var(--color-text)] mb-2">
          {result.already_signed_up ? "You're already on the list!" : "You're in!"}
        </p>
        <p className="text-[var(--color-text-secondary)] mb-4">
          You're{" "}
          <span className="font-bold text-[var(--color-text)]">#{result.position}</span>{" "}
          on the waitlist.
        </p>
        <div className="bg-[var(--color-bg-subtle)] rounded-[var(--radius-md)] p-4 text-sm">
          <p className="text-[var(--color-text-muted)] mb-2">Share your link to move up:</p>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={referralLink}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              aria-label="Your referral link"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => navigator.clipboard.writeText(referralLink)}
            >
              Copy
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 max-w-md mx-auto"
      aria-label="Join the waitlist"
    >
      <div>
        <Label htmlFor="waitlist-name" className="sr-only">
          Your name (optional)
        </Label>
        <Input
          id="waitlist-name"
          type="text"
          placeholder="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
        />
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <Label htmlFor="waitlist-email" className="sr-only">
            Email address
          </Label>
          <Input
            id="waitlist-email"
            type="email"
            required
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            aria-required="true"
            aria-describedby={state === "error" ? "waitlist-error" : undefined}
          />
        </div>
        <Button type="submit" disabled={state === "loading"}>
          {state === "loading" ? "Joining…" : "Join"}
        </Button>
      </div>

      {ref && (
        <p className="text-sm text-[var(--color-text-secondary)]">
          Referred by a friend? You'll get priority access.
        </p>
      )}

      {state === "error" && (
        <p id="waitlist-error" role="alert" className="text-sm text-[var(--color-error)]">
          Something went wrong. Please try again.
        </p>
      )}
    </form>
  );
}

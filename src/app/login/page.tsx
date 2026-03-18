"use client";
import { signIn } from "next-auth/react";

export default function LoginPage() {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#08080d", fontFamily: "'DM Sans', system-ui, sans-serif"
    }}>
      <div style={{ textAlign: "center" }}>
        <div style={{
          width: 56, height: 56, margin: "0 auto 20px",
          background: "linear-gradient(135deg, #e8b84d, #d4a040)",
          borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 28, fontWeight: 800, color: "#08080d"
        }}>H</div>

        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#f0f0f4", marginBottom: 6, letterSpacing: "-0.02em" }}>
          Hive
        </h1>
        <p style={{ fontSize: 13, color: "#6b6b7b", fontFamily: "'JetBrains Mono', monospace", marginBottom: 32 }}>
          venture orchestrator
        </p>

        <button
          onClick={() => signIn("github", { callbackUrl: "/" })}
          style={{
            padding: "10px 24px", fontSize: 14, fontWeight: 600,
            background: "rgba(255,255,255,0.06)", color: "#f0f0f4",
            border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
            cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
            margin: "0 auto", transition: "all 0.15s"
          }}
          onMouseEnter={e => { (e.target as HTMLElement).style.background = "rgba(255,255,255,0.1)"; }}
          onMouseLeave={e => { (e.target as HTMLElement).style.background = "rgba(255,255,255,0.06)"; }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          Sign in with GitHub
        </button>

        <p style={{ fontSize: 11, color: "#33333d", fontFamily: "'JetBrains Mono', monospace", marginTop: 24 }}>
          Single-user access only
        </p>
      </div>
    </div>
  );
}

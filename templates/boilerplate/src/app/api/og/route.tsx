import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

const COMPANY_NAME = "{{COMPANY_NAME}}";
const DEFAULT_DESCRIPTION = "{{DESCRIPTION}}";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const title = searchParams.get("title") || COMPANY_NAME;
  const description = searchParams.get("description") || DEFAULT_DESCRIPTION;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
          padding: "60px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Left content */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: 1,
            paddingRight: "40px",
          }}
        >
          <div
            style={{
              fontSize: 64,
              fontWeight: 800,
              color: "#f8fafc",
              lineHeight: 1.1,
              marginBottom: "20px",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 28,
              color: "#94a3b8",
              lineHeight: 1.4,
            }}
          >
            {description}
          </div>
        </div>

        {/* Right side icon area */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "240px",
          }}
        >
          <div
            style={{
              width: "160px",
              height: "160px",
              borderRadius: "32px",
              background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 72,
              fontWeight: 800,
              color: "#ffffff",
            }}
          >
            {title.charAt(0).toUpperCase()}
          </div>
        </div>

        {/* Bottom accent line */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: "6px",
            background: "linear-gradient(90deg, #3b82f6 0%, #8b5cf6 50%, #ec4899 100%)",
          }}
        />
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}

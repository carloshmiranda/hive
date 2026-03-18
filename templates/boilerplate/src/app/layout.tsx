import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "{{COMPANY_NAME}}",
  description: "{{DESCRIPTION}}",
  openGraph: {
    title: "{{COMPANY_NAME}}",
    description: "{{DESCRIPTION}}",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

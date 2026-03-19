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

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "{{COMPANY_NAME}}",
      url: "{{COMPANY_URL}}",
      description: "{{DESCRIPTION}}",
    },
    {
      "@type": "WebSite",
      name: "{{COMPANY_NAME}}",
      url: "{{COMPANY_URL}}",
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

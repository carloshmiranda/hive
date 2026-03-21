import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "{{COMPANY_NAME}}",
  description: "{{DESCRIPTION}}",
  metadataBase: new URL("{{COMPANY_URL}}"),
  verification: {
    google: "{{GSC_VERIFICATION}}", // Google Search Console
  },
  openGraph: {
    title: "{{COMPANY_NAME}}",
    description: "{{DESCRIPTION}}",
    type: "website",
    images: [
      {
        url: "/api/og",
        width: 1200,
        height: 630,
        alt: "{{COMPANY_NAME}}",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "{{COMPANY_NAME}}",
    description: "{{DESCRIPTION}}",
    images: ["/api/og"],
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
    <html lang="{{LANG}}">
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

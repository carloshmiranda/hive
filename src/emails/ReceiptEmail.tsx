import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Section,
} from "@react-email/components";

interface ReceiptEmailProps {
  companyName: string;
  customerName: string;
  amount: string;
  currency: string;
  plan: string;
  invoiceUrl?: string;
  accentColor?: string;
}

export default function ReceiptEmail({
  companyName,
  customerName,
  amount,
  currency,
  plan,
  invoiceUrl,
  accentColor = "#EF9F27",
}: ReceiptEmailProps) {
  const currentDate = new Date().toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  return (
    <Html>
      <Head />
      <Body style={{ margin: 0, padding: 0, background: "#f8f8f6", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: "#333" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto", padding: "32px 16px" }}>
          <Section style={{ background: "#fff", borderRadius: "12px", padding: "32px", border: "1px solid #e8e8e4" }}>
            {/* Company Name */}
            <Text style={{ fontSize: "18px", fontWeight: 600, color: "#1a1a1a", marginBottom: "24px", margin: "0 0 24px" }}>
              {companyName}
            </Text>

            {/* Greeting */}
            <Text style={{ fontSize: "16px", lineHeight: "1.6", color: "#333", margin: "0 0 16px" }}>
              Hey {customerName},
            </Text>

            {/* Receipt Message */}
            <Text style={{ fontSize: "15px", lineHeight: "1.6", color: "#555", margin: "0 0 24px" }}>
              Thanks for your payment. Here's your receipt:
            </Text>

            {/* Receipt Details */}
            <Section style={{ background: "#f8f8f6", borderRadius: "8px", padding: "20px", marginBottom: "24px" }}>
              <table style={{ width: "100%", fontSize: "14px", color: "#555" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "6px 0" }}>Plan</td>
                    <td style={{ textAlign: "right", fontWeight: 500, color: "#1a1a1a" }}>{plan}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "6px 0" }}>Amount</td>
                    <td style={{ textAlign: "right", fontWeight: 500, color: "#1a1a1a" }}>
                      {currency}{amount}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "6px 0" }}>Date</td>
                    <td style={{ textAlign: "right", color: "#1a1a1a" }}>{currentDate}</td>
                  </tr>
                </tbody>
              </table>
            </Section>

            {/* Invoice Link */}
            {invoiceUrl && (
              <Link
                href={invoiceUrl}
                style={{
                  color: accentColor,
                  textDecoration: "none",
                  fontSize: "14px",
                }}
              >
                View full invoice →
              </Link>
            )}
          </Section>

          {/* Powered by */}
          <Section style={{ textAlign: "center", marginTop: "16px", fontSize: "11px", color: "#999" }}>
            <Text style={{ margin: 0 }}>
              Sent by {companyName} · Powered by Hive
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
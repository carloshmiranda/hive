import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Button,
  Section,
} from "@react-email/components";

interface PasswordResetEmailProps {
  companyName: string;
  resetUrl: string;
  expiresIn?: string;
  accentColor?: string;
}

export default function PasswordResetEmail({
  companyName,
  resetUrl,
  expiresIn = "1 hour",
  accentColor = "#EF9F27",
}: PasswordResetEmailProps) {
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

            {/* Reset Message */}
            <Text style={{ fontSize: "15px", lineHeight: "1.6", color: "#555", margin: "0 0 24px" }}>
              Someone requested a password reset for your account. If this was you, click the button below:
            </Text>

            {/* CTA Button */}
            <Button
              href={resetUrl}
              style={{
                display: "inline-block",
                padding: "12px 28px",
                background: accentColor,
                color: "#fff",
                textDecoration: "none",
                borderRadius: "8px",
                fontWeight: 500,
                fontSize: "15px",
              }}
            >
              Reset password
            </Button>

            {/* Footer */}
            <Text style={{ fontSize: "13px", color: "#999", margin: "24px 0 0" }}>
              This link expires in {expiresIn}. If you didn't request this, you can safely ignore this email.
            </Text>
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
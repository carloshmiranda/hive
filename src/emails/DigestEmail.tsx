import {
  Html,
  Head,
  Body,
  Container,
  Heading,
  Text,
  Section,
  Row,
  Column,
  Link,
} from "@react-email/components";

interface CompanyResult {
  name: string;
  slug: string;
  status: string;
  cycleScore?: number;
  wins: string[];
  misses: string[];
  metrics?: Record<string, string | number>;
}

interface DigestEmailProps {
  date: string;
  totalDuration: string;
  companies: CompanyResult[];
  approvalsPending: Array<{ title: string; gateType: string; companyName?: string }>;
  scoutProposal?: { name: string; description: string; confidence: number };
  errors: string[];
  portfolioMrr: number;
  portfolioCustomers: number;
}

const CompanyRow = ({ company }: { company: CompanyResult }) => {
  const scoreColor = (company.cycleScore || 0) >= 7 ? "#1D9E75" : (company.cycleScore || 0) >= 4 ? "#BA7517" : "#E24B4A";

  return (
    <tr>
      <td style={{ padding: "12px 16px", borderBottom: "1px solid #2C2C2A" }}>
        <Text style={{ color: "#F0F0EC", fontWeight: "bold", margin: 0, display: "inline" }}>
          {company.name}
        </Text>
        <Text style={{ color: "#888780", fontSize: "13px", margin: 0, display: "inline", marginLeft: "4px" }}>
          ({company.slug})
        </Text>
        <span
          style={{
            display: "inline-block",
            marginLeft: "8px",
            padding: "2px 8px",
            borderRadius: "10px",
            fontSize: "12px",
            background: scoreColor,
            color: "#fff",
          }}
        >
          {company.cycleScore || "—"}/10
        </span>
        <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
          {company.wins.map((win, i) => (
            <li key={i} style={{ color: "#1D9E75" }}>✓ {win}</li>
          ))}
          {company.misses.map((miss, i) => (
            <li key={i} style={{ color: "#E24B4A" }}>✗ {miss}</li>
          ))}
        </ul>
      </td>
    </tr>
  );
};

const ApprovalRow = ({ approval }: { approval: { title: string; gateType: string; companyName?: string } }) => (
  <tr>
    <td style={{ padding: "8px 16px", borderBottom: "1px solid #2C2C2A", color: "#F0F0EC", fontSize: "14px" }}>
      <span
        style={{
          padding: "2px 8px",
          borderRadius: "4px",
          background: "#534AB7",
          color: "#fff",
          fontSize: "12px",
          marginRight: "8px",
        }}
      >
        {approval.gateType}
      </span>
      {approval.title}
      {approval.companyName && (
        <Text style={{ color: "#888780", display: "inline", margin: 0, marginLeft: "4px" }}>
          ({approval.companyName})
        </Text>
      )}
    </td>
  </tr>
);

export default function DigestEmail({
  date,
  totalDuration,
  companies,
  approvalsPending,
  scoutProposal,
  errors,
  portfolioMrr,
  portfolioCustomers,
}: DigestEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ margin: 0, padding: 0, background: "#0a0a09", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif", color: "#B4B2A9" }}>
        <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "24px" }}>
          {/* Header */}
          <Section style={{ textAlign: "center", marginBottom: "24px" }}>
            <Text style={{ fontSize: "28px", margin: 0 }}>🐝</Text>
            <Heading style={{ color: "#EF9F27", fontSize: "20px", margin: "8px 0 0", fontWeight: 500 }}>
              Hive nightly digest
            </Heading>
            <Text style={{ color: "#888780", fontSize: "13px", margin: 0 }}>
              {date} · {totalDuration}
            </Text>
          </Section>

          {/* Portfolio Stats */}
          <Section style={{ display: "flex", gap: "16px", marginBottom: "20px", textAlign: "center" }}>
            <Row>
              <Column style={{ flex: 1, padding: "12px", background: "#1a1a18", borderRadius: "8px" }}>
                <Text style={{ color: "#EF9F27", fontSize: "22px", fontWeight: 600, margin: 0 }}>
                  €{portfolioMrr}
                </Text>
                <Text style={{ color: "#888780", fontSize: "12px", margin: 0 }}>
                  Portfolio MRR
                </Text>
              </Column>
              <Column style={{ flex: 1, padding: "12px", background: "#1a1a18", borderRadius: "8px" }}>
                <Text style={{ color: "#5DCAA5", fontSize: "22px", fontWeight: 600, margin: 0 }}>
                  {portfolioCustomers}
                </Text>
                <Text style={{ color: "#888780", fontSize: "12px", margin: 0 }}>
                  Total customers
                </Text>
              </Column>
              <Column style={{ flex: 1, padding: "12px", background: "#1a1a18", borderRadius: "8px" }}>
                <Text style={{ color: "#AFA9EC", fontSize: "22px", fontWeight: 600, margin: 0 }}>
                  {companies.length}
                </Text>
                <Text style={{ color: "#888780", fontSize: "12px", margin: 0 }}>
                  Active companies
                </Text>
              </Column>
            </Row>
          </Section>

          {/* Scout Proposal */}
          {scoutProposal && (
            <Section style={{ margin: "16px 0", padding: "12px 16px", borderLeft: "3px solid #EF9F27", background: "#1a1a18" }}>
              <Text style={{ color: "#EF9F27", fontWeight: "bold", margin: 0 }}>
                💡 Idea Scout proposed:
              </Text>
              <Text style={{ color: "#F0F0EC", margin: 0, display: "inline", marginLeft: "4px" }}>
                {scoutProposal.name}
              </Text>
              <Text style={{ color: "#888780", fontSize: "13px", marginTop: "4px", margin: 0 }}>
                {scoutProposal.description} ({Math.round(scoutProposal.confidence * 100)}% confidence)
              </Text>
            </Section>
          )}

          {/* Company Results */}
          <Heading style={{ color: "#F0F0EC", fontSize: "16px", margin: "20px 0 8px", fontWeight: 500 }}>
            Company results
          </Heading>
          <table style={{ width: "100%", borderCollapse: "collapse", background: "#111110", borderRadius: "8px", overflow: "hidden" }}>
            <tbody>
              {companies.length > 0 ? (
                companies.map((company, i) => <CompanyRow key={i} company={company} />)
              ) : (
                <tr>
                  <td style={{ padding: "12px 16px", color: "#888780", fontSize: "14px" }}>
                    No active companies
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Approvals */}
          <Heading style={{ color: "#F0F0EC", fontSize: "16px", margin: "20px 0 8px", fontWeight: 500 }}>
            Awaiting your decision
          </Heading>
          <table style={{ width: "100%", borderCollapse: "collapse", background: "#111110", borderRadius: "8px", overflow: "hidden" }}>
            <tbody>
              {approvalsPending.length > 0 ? (
                approvalsPending.map((approval, i) => <ApprovalRow key={i} approval={approval} />)
              ) : (
                <tr>
                  <td style={{ padding: "8px 16px", color: "#888780", fontSize: "14px" }}>
                    No pending approvals
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Errors */}
          {errors.length > 0 && (
            <Section style={{ margin: "16px 0", padding: "12px 16px", borderLeft: "3px solid #E24B4A", background: "#1a1a18" }}>
              <Text style={{ color: "#E24B4A", fontWeight: "bold", margin: 0 }}>
                ⚠ Errors:
              </Text>
              <ul style={{ margin: "4px 0 0", paddingLeft: "18px", fontSize: "13px", color: "#F09595" }}>
                {errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </Section>
          )}

          {/* Footer */}
          <Section style={{ textAlign: "center", marginTop: "24px", paddingTop: "16px", borderTop: "1px solid #2C2C2A" }}>
            <Text style={{ color: "#888780", fontSize: "12px", margin: 0 }}>
              Open the <Link href="{{DASHBOARD_URL}}" style={{ color: "#EF9F27", textDecoration: "none" }}>Hive dashboard</Link> to approve, reject, or send directives.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
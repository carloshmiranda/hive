export interface CompanyResult {
  name: string;
  slug: string;
  status: string;
  cycleScore?: number;
  wins: string[];
  misses: string[];
  metrics?: Record<string, string | number>;
}

export interface DigestData {
  date: string;
  totalDuration: string;
  companies: CompanyResult[];
  approvalsPending: Array<{ title: string; gateType: string; companyName?: string }>;
  scoutProposal?: { name: string; description: string; confidence: number };
  errors: string[];
  portfolioMrr: number;
  portfolioCustomers: number;
}

export interface WelcomeEmailData {
  companyName: string;
  customerName: string;
  loginUrl: string;
  accentColor?: string;
}

export interface ReceiptEmailData {
  companyName: string;
  customerName: string;
  amount: string;
  currency: string;
  plan: string;
  invoiceUrl?: string;
  accentColor?: string;
}

export interface PasswordResetEmailData {
  companyName: string;
  resetUrl: string;
  expiresIn?: string;
  accentColor?: string;
}
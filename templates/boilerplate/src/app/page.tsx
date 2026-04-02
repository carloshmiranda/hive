import Link from "next/link";
import { WaitlistForm } from "@/components/waitlist-form";

const LAUNCH_MODE = process.env.NEXT_PUBLIC_LAUNCH_MODE || "waitlist";

function CTAButtons() {
  const href = LAUNCH_MODE === "early_access" ? "/checkout" : "#waitlist";
  const label = LAUNCH_MODE === "early_access" ? "Get early access" : "Get started";
  return (
    <div className="flex gap-4 justify-center">
      <Link href={href} className="px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition">
        {label}
      </Link>
      <a href="#features" className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition">
        Learn more
      </a>
    </div>
  );
}

/* ─── Template placeholders (replaced by Provisioner) ─── */
const COMPANY_NAME = "{{COMPANY_NAME}}";
const DESCRIPTION = "{{DESCRIPTION}}";
const VALUE_PROPOSITION = "{{VALUE_PROPOSITION}}";

/* Features — Provisioner replaces these with real product features from the Scout proposal */
/* Icons are inline SVGs — Engineer should customize per product */
const FEATURES = [
  {
    icon: (
      <svg className="w-6 h-6 text-gray-900" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
      </svg>
    ),
    title: "{{FEATURE_1_TITLE}}",
    description: "{{FEATURE_1_DESC}}",
  },
  {
    icon: (
      <svg className="w-6 h-6 text-gray-900" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
      </svg>
    ),
    title: "{{FEATURE_2_TITLE}}",
    description: "{{FEATURE_2_DESC}}",
  },
  {
    icon: (
      <svg className="w-6 h-6 text-gray-900" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
      </svg>
    ),
    title: "{{FEATURE_3_TITLE}}",
    description: "{{FEATURE_3_DESC}}",
  },
];

/* FAQ — Provisioner replaces with real questions from target audience research */
const FAQS = [
  {
    q: "{{FAQ_1_Q}}",
    a: "{{FAQ_1_A}}",
  },
  {
    q: "{{FAQ_2_Q}}",
    a: "{{FAQ_2_A}}",
  },
  {
    q: "{{FAQ_3_Q}}",
    a: "{{FAQ_3_A}}",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
        <span className="text-lg font-bold text-gray-900">{COMPANY_NAME}</span>
        <div className="flex items-center gap-6 text-sm text-gray-600">
          <a href="#preview" className="hover:text-gray-900 transition">Preview</a>
          <a href="#features" className="hover:text-gray-900 transition">Features</a>
          <a href="#how-it-works" className="hover:text-gray-900 transition">How it works</a>
          <a href="#faq" className="hover:text-gray-900 transition">FAQ</a>
        </div>
      </nav>

      <main>
      {/* Hero */}
      <header id="waitlist" className="max-w-3xl mx-auto px-6 pt-16 pb-20 text-center">
        <div className="inline-block px-3 py-1 mb-6 text-xs font-medium text-gray-600 bg-gray-100 rounded-full">
          Now in early access
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-gray-900 mb-6 leading-tight">
          {DESCRIPTION}
        </h1>
        <p className="text-lg text-gray-500 mb-10 max-w-xl mx-auto leading-relaxed">
          {VALUE_PROPOSITION}
        </p>

        {LAUNCH_MODE === "waitlist" && <WaitlistForm />}
        {LAUNCH_MODE !== "waitlist" && <CTAButtons />}

        <p className="mt-4 text-xs text-gray-400">Free to try. No credit card required.</p>
      </header>

      {/* Product Preview — "See it in action" */}
      <section id="preview" className="max-w-5xl mx-auto px-6 pb-24">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-gray-900 mb-3">See it in action</h2>
          <p className="text-gray-500 max-w-lg mx-auto">A clean, powerful dashboard designed to give you clarity at a glance.</p>
        </div>
        {/* Browser chrome frame with perspective tilt */}
        <div className="relative mx-auto max-w-4xl" style={{ perspective: "1200px" }}>
          <div
            className="bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden"
            style={{ transform: "rotateX(2deg) rotateY(-1deg)", transformOrigin: "center center" }}
          >
            {/* Browser top bar */}
            <div className="bg-gray-100 border-b border-gray-200 px-4 py-3 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-400" />
                <div className="w-3 h-3 rounded-full bg-yellow-400" />
                <div className="w-3 h-3 rounded-full bg-green-400" />
              </div>
              <div className="flex-1 max-w-md mx-auto">
                <div className="bg-white border border-gray-200 rounded-md px-3 py-1 text-xs text-gray-400 font-mono text-center">
                  {COMPANY_NAME.toLowerCase()}.app/dashboard
                </div>
              </div>
              <div className="w-16" />
            </div>

            {/* Dashboard content */}
            <div className="flex min-h-[340px] md:min-h-[420px]">
              {/* Sidebar */}
              <div className="hidden md:flex w-48 bg-gray-50 border-r border-gray-100 flex-col p-4 gap-1">
                <div className="flex items-center gap-2 mb-6">
                  <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
                    </svg>
                  </div>
                  <span className="text-sm font-semibold text-gray-900">{COMPANY_NAME}</span>
                </div>
                {["Dashboard", "Analytics", "Settings", "Billing"].map((item, i) => (
                  <div
                    key={i}
                    className={`px-3 py-2 rounded-md text-sm ${i === 0 ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-500"}`}
                  >
                    {item}
                  </div>
                ))}
                <div className="mt-auto pt-4 border-t border-gray-200">
                  <div className="flex items-center gap-2 px-2">
                    <div className="w-6 h-6 rounded-full bg-gray-200" />
                    <span className="text-xs text-gray-400">user@email.com</span>
                  </div>
                </div>
              </div>

              {/* Main content area */}
              <div className="flex-1 p-4 md:p-6 bg-white">
                {/* Page header */}
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <div className="h-5 w-24 bg-gray-200 rounded mb-1" />
                    <div className="h-3 w-40 bg-gray-100 rounded" />
                  </div>
                  <div className="h-8 w-28 bg-blue-600 rounded-md flex items-center justify-center">
                    <span className="text-xs text-white font-medium">New Report</span>
                  </div>
                </div>

                {/* Stat cards */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
                  {[
                    { label: "{{METRIC_1}}", value: "2,847", change: "+12.5%", up: true },
                    { label: "{{METRIC_2}}", value: "€4,290", change: "+8.2%", up: true },
                    { label: "{{METRIC_3}}", value: "94.2%", change: "-0.3%", up: false },
                  ].map((stat, i) => (
                    <div key={i} className="bg-gray-50 border border-gray-100 rounded-lg p-3 md:p-4">
                      <div className="text-xs text-gray-400 mb-1">{stat.label}</div>
                      <div className="text-lg md:text-xl font-bold text-gray-900">{stat.value}</div>
                      <div className={`text-xs mt-1 ${stat.up ? "text-green-600" : "text-red-500"}`}>{stat.change}</div>
                    </div>
                  ))}
                </div>

                {/* Chart area with SVG bar chart */}
                <div className="bg-gray-50 border border-gray-100 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-medium text-gray-500">Performance Overview</span>
                    <div className="flex gap-3 text-xs text-gray-400">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> This period</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-200 inline-block" /> Last period</span>
                    </div>
                  </div>
                  <svg className="w-full h-28 md:h-36" viewBox="0 0 400 120" preserveAspectRatio="none">
                    {/* Grid lines */}
                    {[0, 30, 60, 90].map((y) => (
                      <line key={y} x1="0" y1={y} x2="400" y2={y} stroke="#f3f4f6" strokeWidth="1" />
                    ))}
                    {/* Previous period bars (lighter) */}
                    {[55, 40, 65, 50, 70, 45, 60, 75, 55, 80, 65, 70].map((h, i) => (
                      <rect key={`prev-${i}`} x={i * 33 + 4} y={120 - h * 0.7} width="11" height={h * 0.7} rx="2" fill="#DBEAFE" />
                    ))}
                    {/* Current period bars */}
                    {[65, 50, 75, 60, 85, 55, 78, 90, 68, 95, 80, 88].map((h, i) => (
                      <rect key={`curr-${i}`} x={i * 33 + 17} y={120 - h * 0.9} width="11" height={h * 0.9} rx="2" fill="#3B82F6" />
                    ))}
                  </svg>
                </div>
              </div>
            </div>
          </div>
          {/* Subtle shadow beneath the tilted frame */}
          <div className="absolute -bottom-4 left-8 right-8 h-8 bg-gradient-to-b from-gray-200/40 to-transparent rounded-full blur-xl -z-10" />
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-4xl mx-auto px-6 py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-gray-900 mb-4">Everything you need</h2>
          <p className="text-gray-500 max-w-lg mx-auto">
            Built for people who want results, not complexity.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-8">
          {FEATURES.map((feature, i) => (
            <div key={i} className="p-6 rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-sm transition">
              <div className="mb-3">{feature.icon}</div>
              <h3 className="font-semibold text-gray-900 mb-2">{feature.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works — with visual mockup thumbnails */}
      <section id="how-it-works" className="bg-gray-50 py-20">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">How it works</h2>
            <p className="text-gray-500">Get started in minutes, not hours.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-10">
            {/* Step 1: Sign up — form mockup */}
            <div className="flex flex-col items-center text-center">
              <div className="w-full max-w-[220px] mb-6">
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="bg-gray-50 border-b border-gray-100 px-3 py-1.5 flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-300" />
                    <div className="w-1.5 h-1.5 rounded-full bg-yellow-300" />
                    <div className="w-1.5 h-1.5 rounded-full bg-green-300" />
                  </div>
                  <div className="p-4 space-y-2.5">
                    <div className="h-3 w-20 bg-gray-200 rounded mx-auto mb-3" />
                    <div className="h-7 w-full bg-gray-50 border border-gray-200 rounded-md" />
                    <div className="h-7 w-full bg-gray-50 border border-gray-200 rounded-md" />
                    <div className="h-7 w-full bg-blue-600 rounded-md flex items-center justify-center">
                      <span className="text-[9px] text-white font-medium">Get Started</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold mb-3">1</div>
              <h3 className="font-semibold text-gray-900 mb-1">{`{{STEP_1_TITLE}}`}</h3>
              <p className="text-sm text-gray-500">{`{{STEP_1_DESC}}`}</p>
            </div>

            {/* Step 2: Configure — settings mockup */}
            <div className="flex flex-col items-center text-center">
              <div className="w-full max-w-[220px] mb-6">
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="bg-gray-50 border-b border-gray-100 px-3 py-1.5 flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-300" />
                    <div className="w-1.5 h-1.5 rounded-full bg-yellow-300" />
                    <div className="w-1.5 h-1.5 rounded-full bg-green-300" />
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="h-3 w-16 bg-gray-200 rounded mb-2" />
                    {/* Toggle rows */}
                    {[true, false, true].map((on, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="h-2.5 w-16 bg-gray-100 rounded" />
                        <div className={`w-8 h-4 rounded-full flex items-center px-0.5 ${on ? "bg-blue-600 justify-end" : "bg-gray-200 justify-start"}`}>
                          <div className="w-3 h-3 rounded-full bg-white shadow-sm" />
                        </div>
                      </div>
                    ))}
                    {/* Dropdown */}
                    <div className="h-7 w-full bg-gray-50 border border-gray-200 rounded-md flex items-center px-2 justify-between">
                      <span className="text-[8px] text-gray-400">Select option...</span>
                      <svg className="w-2.5 h-2.5 text-gray-300" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
                    </div>
                  </div>
                </div>
              </div>
              <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold mb-3">2</div>
              <h3 className="font-semibold text-gray-900 mb-1">{`{{STEP_2_TITLE}}`}</h3>
              <p className="text-sm text-gray-500">{`{{STEP_2_DESC}}`}</p>
            </div>

            {/* Step 3: See results — mini dashboard mockup */}
            <div className="flex flex-col items-center text-center">
              <div className="w-full max-w-[220px] mb-6">
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="bg-gray-50 border-b border-gray-100 px-3 py-1.5 flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-300" />
                    <div className="w-1.5 h-1.5 rounded-full bg-yellow-300" />
                    <div className="w-1.5 h-1.5 rounded-full bg-green-300" />
                  </div>
                  <div className="p-4 space-y-2.5">
                    {/* Mini stat cards */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-gray-50 border border-gray-100 rounded p-2">
                        <div className="h-2 w-8 bg-gray-200 rounded mb-1" />
                        <div className="h-3 w-10 bg-gray-300 rounded" />
                      </div>
                      <div className="bg-gray-50 border border-gray-100 rounded p-2">
                        <div className="h-2 w-8 bg-gray-200 rounded mb-1" />
                        <div className="h-3 w-10 bg-blue-200 rounded" />
                      </div>
                    </div>
                    {/* Mini line chart */}
                    <div className="bg-gray-50 border border-gray-100 rounded p-2">
                      <svg className="w-full h-10" viewBox="0 0 160 40" preserveAspectRatio="none">
                        <polyline
                          points="0,35 20,30 40,25 60,28 80,18 100,15 120,10 140,12 160,5"
                          fill="none"
                          stroke="#3B82F6"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <polyline
                          points="0,35 20,30 40,25 60,28 80,18 100,15 120,10 140,12 160,5"
                          fill="url(#chartGradient)"
                          stroke="none"
                        />
                        <defs>
                          <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.15" />
                            <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                      </svg>
                    </div>
                    {/* Success indicator */}
                    <div className="flex items-center gap-1.5 justify-center">
                      <div className="w-3 h-3 rounded-full bg-green-400 flex items-center justify-center">
                        <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                      </div>
                      <span className="text-[8px] text-green-600 font-medium">All systems go</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold mb-3">3</div>
              <h3 className="font-semibold text-gray-900 mb-1">{`{{STEP_3_TITLE}}`}</h3>
              <p className="text-sm text-gray-500">{`{{STEP_3_DESC}}`}</p>
            </div>
          </div>

          {/* Connector line between steps (desktop only) */}
          <div className="hidden md:flex justify-center mt-[-340px] mb-[280px] px-16 pointer-events-none" aria-hidden="true">
            <div className="flex-1 border-t-2 border-dashed border-gray-200 mt-[88px]" />
            <div className="flex-1 border-t-2 border-dashed border-gray-200 mt-[88px]" />
          </div>
        </div>
      </section>

      {/* Social proof — only shown when real data exists (e.g. waitlist count). Skip entirely for MVP launch. */}

      {/* FAQ */}
      <section id="faq" className="bg-gray-50 py-20">
        <div className="max-w-2xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-gray-900 mb-12 text-center">Frequently asked questions</h2>
          <div className="space-y-6">
            {FAQS.map((faq, i) => (
              <details key={i} className="group bg-white rounded-xl border border-gray-200 px-6 py-4">
                <summary className="cursor-pointer font-medium text-gray-900 flex items-center justify-between">
                  {faq.q}
                  <span className="text-gray-400 group-open:rotate-45 transition-transform text-lg">+</span>
                </summary>
                <p className="mt-3 text-sm text-gray-500 leading-relaxed">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="max-w-3xl mx-auto px-6 py-20 text-center">
        <h2 className="text-3xl font-bold text-gray-900 mb-4">Ready to get started?</h2>
        <p className="text-gray-500 mb-8 max-w-md mx-auto">
          Join hundreds of early adopters who are already saving time.
        </p>
        {LAUNCH_MODE === "waitlist" && <WaitlistForm />}
        {LAUNCH_MODE !== "waitlist" && <CTAButtons />}
      </section>

      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 py-12">
        <div className="max-w-4xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="font-bold text-gray-900">{COMPANY_NAME}</span>
          <div className="flex gap-6 text-sm text-gray-500">
            <a href="#preview" className="hover:text-gray-900 transition">Preview</a>
            <a href="#features" className="hover:text-gray-900 transition">Features</a>
            <a href="#how-it-works" className="hover:text-gray-900 transition">How it works</a>
            <a href="#faq" className="hover:text-gray-900 transition">FAQ</a>
          </div>
          <p className="text-sm text-gray-400">&copy; {new Date().getFullYear()} {COMPANY_NAME}</p>
        </div>
      </footer>
    </div>
  );
}

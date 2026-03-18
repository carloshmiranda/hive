import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Hero */}
      <header className="max-w-3xl mx-auto px-6 py-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-gray-900 mb-4">
          {"{{COMPANY_NAME}}"}
        </h1>
        <p className="text-lg text-gray-600 mb-8 max-w-xl mx-auto">
          {"{{DESCRIPTION}}"}
        </p>
        <div className="flex gap-4 justify-center">
          <Link href="/checkout" className="px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition">
            Get started
          </Link>
          <a href="#features" className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition">
            Learn more
          </a>
        </div>
      </header>

      {/* Features placeholder */}
      <section id="features" className="max-w-4xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-3 gap-8">
          {["Fast", "Simple", "Reliable"].map((feature, i) => (
            <div key={i} className="p-6 border border-gray-200 rounded-xl">
              <h3 className="font-semibold text-gray-900 mb-2">{feature}</h3>
              <p className="text-sm text-gray-500">Description of this feature and why it matters to the user.</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="max-w-3xl mx-auto px-6 py-12 text-center text-sm text-gray-400">
        {"{{COMPANY_NAME}}"} · Built with care
      </footer>
    </div>
  );
}

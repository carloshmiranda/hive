import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-6">
      <div className="text-center">
        <p className="text-sm font-medium text-gray-500 mb-2">404</p>
        <h1 className="text-3xl font-bold text-gray-900 mb-4">Page not found</h1>
        <p className="text-gray-500 mb-8 max-w-sm mx-auto">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition"
        >
          Back to {"{{COMPANY_NAME}}"}
        </Link>
      </div>
    </main>
  );
}

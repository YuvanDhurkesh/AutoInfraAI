import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-24">
      <h1 className="text-4xl font-semibold">AutoInfra</h1>
      <p className="text-slate-400">
        Paste a GitHub repo. Get a Free-Tier-eligible AWS architecture, designed and deployed by AI,
        with a working HTTPS URL.
      </p>
      <div className="flex gap-4">
        <Link href="/signup" className="rounded bg-indigo-500 px-4 py-2 font-medium text-white">
          Sign up
        </Link>
        <Link href="/login" className="rounded border border-slate-700 px-4 py-2 font-medium">
          Log in
        </Link>
      </div>
    </main>
  );
}

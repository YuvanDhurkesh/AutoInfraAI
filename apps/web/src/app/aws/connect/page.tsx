"use client";

import Link from "next/link";
import { ConnectAws } from "@/components/connect-aws";

export default function AwsConnectPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-24">
      <h1 className="text-2xl font-semibold">Connect AWS</h1>
      <ConnectAws />
      <Link href="/deployments/new" className="text-sm text-indigo-300">
        Deploy a repository &rarr;
      </Link>
    </main>
  );
}

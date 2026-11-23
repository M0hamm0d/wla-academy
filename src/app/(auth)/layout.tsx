import Link from "next/link";

/**
 * AUTH SHELL — the quiet transition from public site into the Academy
 * (UI/UX §68: "The interface should become progressively quieter at each
 * step"). No navigation: nothing here should compete with the one task.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <header className="wla-container flex min-h-[72px] items-center">
        <Link
          href="/"
          className="font-[family-name:var(--font-serif)] text-[length:var(--text-h3)]"
        >
          Within Lab
        </Link>
      </header>
      <main className="wla-container">
        <div className="mx-auto w-full max-w-[26rem] py-[var(--space-xl)]">
          {children}
        </div>
      </main>
    </div>
  );
}

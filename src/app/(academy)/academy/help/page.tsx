import { AcademyShell } from "@/components/academy/academy-shell";

export const metadata = { title: "Help" };

export default function HelpPage() {
  return (
    <AcademyShell>
      <main className="wla-container py-[var(--space-2xl)]">
        <h1 className="text-[length:var(--text-h1)]">Help</h1>
        <div className="mt-[var(--space-l)] flex flex-col gap-[var(--space-l)] wla-measure">
          <section>
            <h2 className="text-[length:var(--text-h3)]">I can&rsquo;t open a mission</h2>
            <p className="mt-[var(--space-xs)] text-[var(--color-text-muted)]">
              Check that the correct child profile is selected and that the 
              mission appears in My Missions.
            </p>
          </section>
          <section>
            <h2 className="text-[length:var(--text-h3)]">My Child Access Code doesn&rsquo;t work</h2>
            <p className="mt-[var(--space-xs)] text-[var(--color-text-muted)]">
              A parent can create a new code from the child's profile in 
              Account. The previous code will stop working. 
            </p>
          </section>
          <section>
            <h2 className="text-[length:var(--text-h3)]">How do I continue a mission?</h2>
            <p className="mt-[var(--space-xs)] text-[var(--color-text-muted)]">
              In My Missions, find your mission and select <b>Continue</b>. Your 
              saved Academy progress should be available.
            </p>
          </section>
          <section>
            <h2 className="text-[length:var(--text-h3)]">Need more help?</h2>
            <p className="mt-[var(--space-xs)] text-[var(--color-text-muted)]">
              If your progress is missing or you have trouble with access, 
              resources, instructions, or safety and privacy, <a href="https://wla-xi.vercel.app/contact" className="text-[var(--color-text-link)] underline">contact WLA.</a> 
            </p> <a href="https://wla-xi.vercel.app/contact" target="_blank" rel="noopener noreferrer"></a>
          </section>

        </div>
      </main>
    </AcademyShell>
  );
}

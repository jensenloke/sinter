import { LoginCard } from "./login-card";
import { Brand } from "./brand";

export default function Home() {
  return (
    <main className="shell">
      <nav className="nav">
        <Brand />
        <span className="status"><i />Private development preview</span>
      </nav>
      <section className="hero">
        <div className="copy">
          <p className="eyebrow">SESSION CONTINUITY</p>
          <h1>Continue on another device, without giving up your context.</h1>
          <p className="lede">
            Sinter Cloud is the encrypted bridge between your local coding-agent sessions.
            Your CLI keeps the keys; the cloud stores ciphertext.
          </p>
          <div className="principles">
            <div><strong>Local-first</strong><span>The CLI remains useful without an account.</span></div>
            <div><strong>End-to-end encrypted</strong><span>Plaintext transcripts never reach the service.</span></div>
            <div><strong>Explicit movement</strong><span>Inspect before sending, importing, or deleting.</span></div>
          </div>
        </div>
        <LoginCard />
      </section>
      <footer>Development foundation · Real session uploads are disabled</footer>
    </main>
  );
}

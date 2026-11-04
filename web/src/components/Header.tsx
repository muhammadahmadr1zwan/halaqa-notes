import { Link } from "react-router-dom";
import { signOut } from "../lib/client";
import { Icon } from "./ui";

export function Header() {
  return (
    <header className="no-print sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5 text-xl font-semibold">
          <img src="/favicon.svg" alt="" className="size-8" />
          Halaqa Notes
        </Link>
        <button onClick={signOut} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-muted hover:bg-brand-soft hover:text-ink">
          <Icon name="logout" />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}

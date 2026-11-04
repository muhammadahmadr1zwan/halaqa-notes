import { useState } from "react";
import { login } from "../lib/client";
import { Button, Card, Spinner } from "../components/ui";

export function Login() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <Card className="w-full max-w-md p-8 shadow-sm">
        <div className="mb-6 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto size-14" />
          <h1 className="mt-3 text-3xl font-semibold">Halaqa Notes</h1>
          <p className="mt-1 text-muted">Your private class transcripts</p>
        </div>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await login(password);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="grid gap-1.5">
            <span className="font-medium">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="min-h-12 rounded-xl border border-line bg-paper px-4 text-lg outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </label>
          {error && <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger">{error}</p>}
          <Button variant="primary" type="submit" disabled={busy} className="min-h-12 text-lg">
            {busy && <Spinner />} Sign in
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-muted">You'll stay signed in on this device.</p>
      </Card>
    </main>
  );
}

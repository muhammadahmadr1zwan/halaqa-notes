/**
 * The site's real API handler on an in-memory Blobs store whose reads/writes yield between steps, so concurrent
 * requests genuinely interleave. Conditional writes (onlyIfNew) are atomic, like the real store.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const data = new Map<string, unknown>();
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
const store = {
  async get(key: string) {
    await tick();
    return data.has(key) ? structuredClone(data.get(key)) : null;
  },
  async getWithMetadata(key: string) {
    await tick();
    return data.has(key) ? { data: structuredClone(data.get(key)), etag: undefined, metadata: {} } : null; // like the local emulator: no etag
  },
  async setJSON(key: string, value: unknown, opts: { onlyIfNew?: boolean } = {}) {
    await tick();
    if (opts.onlyIfNew && data.has(key)) return { modified: false };
    data.set(key, structuredClone(value));
    return { modified: true };
  },
  async delete(key: string) {
    await tick();
    data.delete(key);
  },
  async list({ prefix }: { prefix: string }) {
    await tick();
    return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  },
};
vi.mock("@netlify/blobs", () => ({ getStore: () => store }));

let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  process.env.WORKER_SECRET = "test-secret";
  handler = (await import("../../netlify/functions/api.mts")).default;
});
const worker = async (method: string, path: string, body?: unknown) => {
  const res = await handler(
    new Request(`http://site/api/worker${path}`, {
      method,
      headers: { "x-worker-secret": "test-secret", "x-worker-kind": "cloud", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("cloud lease (one run at a time)", () => {
  it("of many runs racing for a free lease, exactly one wins", async () => {
    data.clear();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => worker("POST", "/cloud-lease", { runner: `cloud-${i}` })));
    expect(results.filter((r) => r.body.ok).length).toBe(1);
  });

  it("after a crash (lease expired, never released), racing runs: exactly one takes over", async () => {
    data.clear();
    data.set("meta/cloud-lease", { runner: "cloud-dead", until: new Date(Date.now() - 60_000).toISOString(), gen: 7 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => worker("POST", "/cloud-lease", { runner: `cloud-${i}` })));
    const winners = results.filter((r) => r.body.ok);
    expect(winners.length).toBe(1);
    expect((data.get("meta/cloud-lease") as { gen: number }).gen).toBe(8);
  });

  const usage = () => (data.get(`meta/cloud-usage/${new Date().toISOString().slice(0, 7)}`) as { seconds: number } | undefined)?.seconds ?? 0;

  it("a live lease blocks others; a normal release lets the next run start at once and is charged its real time only", async () => {
    data.clear();
    expect((await worker("POST", "/cloud-lease", { runner: "cloud-a" })).body.ok).toBe(true);
    expect((await worker("POST", "/cloud-lease", { runner: "cloud-b" })).body).toMatchObject({ ok: false, reason: "busy" });
    await worker("POST", "/cloud-lease", { runner: "cloud-a", release: true, seconds: 60 });
    expect((await worker("POST", "/cloud-lease", { runner: "cloud-b" })).body.ok).toBe(true);
    expect(usage()).toBe(60); // not 60 + 900: a released run isn't treated as crashed
  });

  it("a late release from an old run can't touch the new owner's lease, and isn't double-counted", async () => {
    data.clear();
    data.set("meta/cloud-lease", { runner: "cloud-old", until: new Date(Date.now() - 1000).toISOString(), gen: 3 });
    expect((await worker("POST", "/cloud-lease", { runner: "cloud-new" })).body.ok).toBe(true); // takeover: old run counted as 900 s
    const owned = structuredClone(data.get("meta/cloud-lease"));
    expect((await worker("POST", "/cloud-lease", { runner: "cloud-old", release: true, seconds: 840 })).body.late).toBe(true);
    expect(data.get("meta/cloud-lease")).toEqual(owned);
    expect(usage()).toBe(900);
    expect((await worker("POST", "/cloud-lease", { runner: "cloud-x" })).body.reason).toBe("busy"); // new owner still holds it
  });

  it("a release racing a takeover attempt never leaves two owners", async () => {
    for (let round = 0; round < 20; round++) {
      data.clear();
      await worker("POST", "/cloud-lease", { runner: "cloud-a" });
      const [, ...others] = await Promise.all([
        worker("POST", "/cloud-lease", { runner: "cloud-a", release: true, seconds: 30 }),
        ...["b", "c", "d"].map((x) => worker("POST", "/cloud-lease", { runner: `cloud-${x}` })),
      ]);
      expect(others.filter((r) => r.body.ok).length).toBeLessThanOrEqual(1);
      const winner = others.find((r) => r.body.ok);
      if (winner) expect(Date.parse((data.get("meta/cloud-lease") as { until: string }).until)).toBeGreaterThan(Date.now()); // winner's lease stands
    }
  });
});

describe("lecture parts (each window stored on its own)", () => {
  const plan = [0, 1, 2, 3].map((i) => ({ idx: i, start_s: i * 1200, end_s: (i + 1) * 1200, segments: null, provider: null, done: false }));
  const seg = (i: number, text: string) => [{ start: i * 1200 + 5, end: i * 1200 + 9, text, speaker: "S1" }];

  it("parallel saves never overwrite each other; a repeat can't replace or duplicate; assembly is in time order", async () => {
    data.clear();
    data.set("class/c1", { id: "c1", locked_by: "cloud-a" });
    await worker("PUT", "/classes/c1/chunks", plan);
    // Windows finish out of order and all at once.
    await Promise.all([3, 1, 0].map((i) => worker("PUT", `/classes/c1/chunks/${i}`, { segments: seg(i, `part ${i} بسم الله`), provider: "gemini", owner: "cloud-a" })));
    const again = await worker("PUT", "/classes/c1/chunks/1", { segments: seg(1, "a second copy"), provider: "gemini", owner: "cloud-a" });
    expect(again.body.already).toBe(true);

    const rows = (await worker("GET", "/classes/c1/chunks")).body as unknown as Array<{ idx: number; done: boolean; segments: Array<{ text: string; start: number }> | null }>;
    expect(rows.map((r) => r.done)).toEqual([true, true, false, true]); // part 2 still missing → it is the one retried
    const text = rows.flatMap((r) => r.segments ?? []);
    expect(text.map((s) => s.text)).toEqual(["part 0 بسم الله", "part 1 بسم الله", "part 3 بسم الله"]);
    expect(text.map((s) => s.start)).toEqual([...text.map((s) => s.start)].sort((a, b) => a - b));
  });

  it("a lecture half-done in the OLD storage format keeps its finished parts after the upgrade", async () => {
    data.clear();
    data.set("class/c2", { id: "c2", locked_by: "cloud-a" });
    // Old format: finished windows lived inside the chunks array itself.
    data.set("chunks/c2", plan.slice(0, 3).map((r, i) => (i < 2 ? { ...r, done: true, provider: "gemini:old", segments: seg(i, `old ${i}`) } : r)));
    let rows = (await worker("GET", "/classes/c2/chunks")).body as unknown as Array<{ done: boolean; segments: Array<{ text: string }> | null }>;
    expect(rows.map((r) => r.done)).toEqual([true, true, false]);
    // The new code saves the remaining window as a separate part; nothing old is lost or replaced.
    await worker("PUT", "/classes/c2/chunks/2", { segments: seg(2, "new 2"), provider: "gemini", owner: "cloud-a" });
    rows = (await worker("GET", "/classes/c2/chunks")).body as unknown as typeof rows;
    expect(rows.flatMap((r) => r.segments ?? []).map((s) => s.text)).toEqual(["old 0", "old 1", "new 2"]);
  });

  it("the early preview reads finished windows from their own blobs", async () => {
    process.env.APP_PASSWORD = "mom";
    process.env.SESSION_SECRET = "test-session";
    data.set("chunks/c3", plan);
    data.set("part/c3/0", { start_s: 0, end_s: 1200, segments: seg(0, "opened بسم الله"), provider: "gemini" });
    const login = await handler(new Request("http://site/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "mom" }) }));
    const { token } = (await login.json()) as { token: string };
    const res = await handler(new Request("http://site/api/classes/c3/partial", { headers: { authorization: `Bearer ${token}` } }));
    const body = (await res.json()) as { partsDone: number; partsTotal: number; segments: Array<{ text: string }> };
    expect(body.partsDone).toBe(1);
    expect(body.partsTotal).toBe(4);
    expect(body.segments.map((s) => s.text)).toEqual(["opened بسم الله"]);
  });

  it("search matches Arabic titles and transcripts after removing vowel marks", async () => {
    process.env.APP_PASSWORD = "mom";
    process.env.SESSION_SECRET = "test-session";
    data.set("class/c-search", { id: "c-search", title: "شرح الإيمان", status: "completed" });
    data.set("search/c-search", { class_id: "c-search", search_text: "ان الله غفور رحيم" });
    const login = await handler(new Request("http://site/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "mom" }) }));
    const { token } = (await login.json()) as { token: string };
    const byTitle = await handler(new Request(`http://site/api/search?q=${encodeURIComponent("إيمان")}`, { headers: { authorization: `Bearer ${token}` } }));
    const titleHits = (await byTitle.json()) as Array<{ class_id: string }>;
    expect(titleHits.map((h) => h.class_id)).toContain("c-search");
    const byText = await handler(new Request(`http://site/api/search?q=${encodeURIComponent("اللَّه")}`, { headers: { authorization: `Bearer ${token}` } }));
    const textHits = (await byText.json()) as Array<{ class_id: string; snippet: string | null }>;
    expect(textHits.find((h) => h.class_id === "c-search")?.snippet).toContain("الله");
  });

  it("a stale run cannot release or overwrite a newer owner's fresh lock", async () => {
    data.set("class/c1", { id: "c1", status: "processing", locked_by: "cloud-new", locked_at: new Date().toISOString() });
    const stale = await worker("PATCH", "/classes/c1", { owner: "cloud-old", status: "queued", locked_by: null, locked_at: null });
    expect(stale.status).toBe(409);
    expect((data.get("class/c1") as { locked_by: string }).locked_by).toBe("cloud-new");
    const current = await worker("PATCH", "/classes/c1", { owner: "cloud-new", status_message: "Transcribing…" });
    expect(current.status).toBe(200);
    expect((data.get("class/c1") as { status_message: string }).status_message).toBe("Transcribing…");
    expect((data.get("class/c1") as { owner?: string }).owner).toBeUndefined();
  });

  it("a run that no longer holds the lecture can't save", async () => {
    data.set("class/c1", { id: "c1", locked_by: "cloud-new" });
    const r = await worker("PUT", "/classes/c1/chunks/2", { segments: seg(2, "stale"), provider: "gemini", owner: "cloud-a" });
    expect(r.status).toBe(409);
    expect(data.has("part/c1/2")).toBe(false);
  });
});

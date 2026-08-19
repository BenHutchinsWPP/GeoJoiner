import { describe, it, expect, afterEach } from "vitest";
import { fetchAllWithProgress } from "../layerConfig";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Serve `bodies` by url; anything else 404s. */
function stubFetch(bodies: Record<string, number>) {
  globalThis.fetch = (async (url: string) => {
    const size = bodies[String(url)];
    if (size === undefined) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(size), {
      headers: { "content-length": String(size) },
    });
  }) as typeof fetch;
}

describe("fetchAllWithProgress", () => {
  it("reports total from Content-Length and ends at the full size", async () => {
    stubFetch({ "/a.gjbf": 1000, "/b.grid": 500 });
    const seen: [number, number][] = [];
    const out = await fetchAllWithProgress(["/a.gjbf", "/b.grid"], (l, t) => seen.push([l, t]));

    expect(out.get("/a.gjbf")!.byteLength).toBe(1000);
    expect(out.get("/b.grid")!.byteLength).toBe(500);
    expect(seen[0]).toEqual([0, 1500]);
    expect(seen[seen.length - 1]).toEqual([1500, 1500]);
  });

  it("skips failed urls instead of rejecting", async () => {
    stubFetch({ "/a.gjbf": 100 });
    const out = await fetchAllWithProgress(["/a.gjbf", "/missing.grid"], () => {});
    expect(out.has("/a.gjbf")).toBe(true);
    expect(out.has("/missing.grid")).toBe(false);
  });
});

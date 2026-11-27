import { describe, expect, it, vi } from "vitest";
import { safeUnzip } from "../../../src/sources/archives/safe-unzip";

/*
 * Issue #41 B15: a 1.5MB ZIP (ratio ~1015:1) took the worker from 72MB to 2096MB before it was
 * refused, because safe-unzip fed fflate 1MiB of compressed input at a time and fflate inflates a
 * whole push in one call — the limits were checked only on the ~1GB that came out.
 *
 * fflate's decoder is wrapped to count every byte it hands to safe-unzip. A bomb must be stopped
 * after at most the ratio floor (1 MiB) plus what ONE input piece can inflate to: deflate expands
 * at most ~1032:1, and safe-unzip feeds 16 KiB pieces.
 */
const seen = vi.hoisted(() => ({ bytes: 0, largest: 0 }));

vi.mock("fflate", async (importOriginal) => {
  const real = await importOriginal<typeof import("fflate")>();
  type Handler = InstanceType<typeof real.UnzipInflate>["ondata"];
  class CountingInflate extends real.UnzipInflate {
    constructor() {
      super();
      // fflate's Unzip assigns ondata after construction; every inflated chunk passes through here
      let sink: Handler = () => {};
      Object.defineProperty(this, "ondata", {
        get: () => sink,
        set: (fn: Handler) => {
          sink = (err, data, final) => {
            if (data) (seen.bytes += data.length), (seen.largest = Math.max(seen.largest, data.length));
            fn(err, data, final);
          };
        },
      });
    }
  }
  return { ...real, UnzipInflate: CountingInflate };
});

const MAX_DEFLATE_RATIO = 1032;
const PIECE = 16 * 1024;
const RATIO_FLOOR = 1024 ** 2;
const BOUND = RATIO_FLOOR + PIECE * MAX_DEFLATE_RATIO;

/** A ZIP whose one entry inflates to `mib` MiB of zeros, built without holding them in memory. */
async function zeroBomb(mib: number): Promise<Uint8Array> {
  const { Zip, ZipDeflate } = await vi.importActual<typeof import("fflate")>("fflate");
  const parts: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    parts.push(chunk);
  });
  const f = new ZipDeflate("bomb.txt", { level: 9 });
  zip.add(f);
  const mb = new Uint8Array(1024 ** 2);
  for (let i = 0; i < mib; i++) f.push(mb, i === mib - 1);
  zip.end();
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (data.set(p, o), (o += p.length));
  return data;
}

describe("safeUnzip — memory held for a ZIP bomb stays bounded (Issue #41 B15)", () => {
  it("a 128MiB bomb is refused after at most one small piece is inflated", async () => {
    const bomb = await zeroBomb(128);
    expect(bomb.length).toBeLessThan(1024 ** 2); // the whole bomb used to fit in ONE 1MiB push
    seen.bytes = seen.largest = 0;
    expect(() => safeUnzip(bomb)).toThrow(expect.objectContaining({ code: "archive/suspicious-ratio" }));
    expect(seen.largest).toBeLessThanOrEqual(PIECE * MAX_DEFLATE_RATIO);
    expect(seen.bytes).toBeLessThanOrEqual(BOUND);
  }, 60_000);

  it("the total limit is enforced during inflation, not after a push expanded past it", async () => {
    const bomb = await zeroBomb(128);
    const limit = 8 * 1024 ** 2;
    seen.bytes = seen.largest = 0;
    // the ratio check is switched off here, so only the size limit can stop it
    expect(() => safeUnzip(bomb, { limits: { maxTotalBytes: limit, maxRatio: 10_000 } })).toThrow(
      expect.objectContaining({ code: "archive/too-large" }),
    );
    expect(seen.bytes).toBeLessThanOrEqual(limit + PIECE * MAX_DEFLATE_RATIO);
  }, 60_000);
});

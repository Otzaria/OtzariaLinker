import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/database/compression/sha256";

const node = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ascii = (s: string) => new TextEncoder().encode(s);

describe("sha256Hex (fingerprints of zstd dictionaries)", () => {
  it("FIPS 180-4 test vectors", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(ascii("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with Node's crypto across block boundaries, and on a view into a larger buffer", () => {
    const big = new Uint8Array(300);
    for (let i = 0; i < big.length; i++) big[i] = (i * 151 + 7) & 255;
    for (let n = 0; n <= 200; n++) expect(sha256Hex(big.subarray(13, 13 + n)), `length ${n}`).toBe(node(big.subarray(13, 13 + n)));
    const mb = new Uint8Array(2 * 1024 * 1024 + 3).map((_, i) => (i * 31) & 255);
    expect(sha256Hex(mb)).toBe(node(mb));
  });
});

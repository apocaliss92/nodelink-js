import { describe, expect, it } from "vitest";
import { bcDecrypt, bcEncrypt, deriveAesKey, md5StrModern } from "../src/protocol/crypto.js";
import { aesDecrypt, aesEncrypt } from "../src/protocol/crypto.js";

describe("crypto", () => {
  it("md5StrModern truncates to 31 uppercase hex chars", () => {
    const v = md5StrModern("admin");
    expect(v).toMatch(/^[0-9A-F]{31}$/);
  });

  it("bcEncrypt/bcDecrypt roundtrip", () => {
    const plain = Buffer.from("<?xml version=\"1.0\"?><x>ciao</x>", "utf8");
    const enc = bcEncrypt(plain, 250);
    const dec = bcDecrypt(enc, 250);
    expect(dec.toString("utf8")).toBe(plain.toString("utf8"));
  });

  it("deriveAesKey is 16 bytes", () => {
    const key = deriveAesKey("9E6D1FCB9E69846D", "123456");
    expect(key.length).toBe(16);
  });

  it("aesEncrypt/aesDecrypt roundtrip", () => {
    const key = deriveAesKey("9E6D1FCB9E69846D", "123456");
    const plain = Buffer.from("<?xml version=\"1.0\"?><x>test</x>", "utf8");
    const enc = aesEncrypt(plain, key);
    const dec = aesDecrypt(enc, key);
    expect(dec.toString("utf8")).toBe(plain.toString("utf8"));
  });
});


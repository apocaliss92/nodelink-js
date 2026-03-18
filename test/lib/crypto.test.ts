import { describe, it, expect } from "vitest";
import {
  md5HexUpper,
  bcEncrypt,
  bcDecrypt,
  aesEncrypt,
  aesDecrypt,
} from "../../src/protocol/crypto";

describe("Crypto", () => {
  describe("md5HexUpper", () => {
    it("computes MD5 hash in uppercase hex", () => {
      const result = md5HexUpper("admin");
      expect(result).toMatch(/^[0-9A-F]{32}$/);
      expect(result).toBe("21232F297A57A5A743894A0E4A801FC3");
    });

    it("handles empty string", () => {
      const result = md5HexUpper("");
      expect(result).toBe("D41D8CD98F00B204E9800998ECF8427E");
    });
  });

  describe("bcEncrypt / bcDecrypt (XOR with offset)", () => {
    it("round-trips data correctly", () => {
      const plaintext = Buffer.from("Hello, Baichuan!");
      const offset = 42;
      const encrypted = bcEncrypt(Buffer.from(plaintext), offset);
      const decrypted = bcDecrypt(encrypted, offset);
      expect(decrypted).toEqual(plaintext);
    });

    it("XOR is symmetric with same offset", () => {
      const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const offset = 7;
      const enc = bcEncrypt(Buffer.from(data), offset);
      const dec = bcEncrypt(enc, offset);
      expect(dec).toEqual(data);
    });

    it("handles empty data", () => {
      const result = bcEncrypt(Buffer.alloc(0), 0);
      expect(result.length).toBe(0);
    });
  });

  describe("aesEncrypt / aesDecrypt (AES-128-CFB)", () => {
    it("round-trips data correctly", () => {
      const key = Buffer.alloc(16, 0x42);
      const plaintext = Buffer.from("AES test payload for Reolink camera protocol");
      const encrypted = aesEncrypt(plaintext, key);
      expect(encrypted).not.toEqual(plaintext);
      const decrypted = aesDecrypt(encrypted, key);
      expect(decrypted).toEqual(plaintext);
    });

    it("produces different ciphertext for different keys", () => {
      const data = Buffer.from("same plaintext");
      const key1 = Buffer.alloc(16, 0x01);
      const key2 = Buffer.alloc(16, 0x02);
      const enc1 = aesEncrypt(data, key1);
      const enc2 = aesEncrypt(data, key2);
      expect(enc1).not.toEqual(enc2);
    });

    it("handles single byte", () => {
      const key = Buffer.alloc(16, 0xaa);
      const data = Buffer.from([0x55]);
      const enc = aesEncrypt(data, key);
      const dec = aesDecrypt(enc, key);
      expect(dec).toEqual(data);
    });
  });
});

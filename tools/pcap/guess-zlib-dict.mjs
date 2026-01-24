#!/usr/bin/env node
import crypto from "node:crypto";
import "dotenv/config";
import { deriveAesKey } from "../../dist/index.cjs";

function usage() {
    console.error(`Usage:
  node tools/pcap/guess-zlib-dict.mjs <dictIdHex> --nonce <nonce>

Tries a small set of plausible dictionaries derived from nonce/password/sessionKey/header-ish values and prints adler32 matches.`);
    process.exit(2);
}

function adler32(buf) {
    let a = 1;
    let b = 0;
    const MOD = 65521;
    for (let i = 0; i < buf.length; i++) {
        a = (a + buf[i]) % MOD;
        b = (b + a) % MOD;
    }
    return (((b << 16) | a) >>> 0);
}

const dictHex = process.argv[2];
if (!dictHex) usage();

let nonce = null;
for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--nonce") nonce = String(process.argv[++i] ?? "");
}
if (!nonce) usage();

const target = Number.parseInt(dictHex.replace(/^0x/i, ""), 16) >>> 0;

const password = (process.env.BAICHUAN_PASSWORD ?? process.env.NVR_PASSWORD ?? "").trim();
const candidates = [];

function add(name, b) {
    candidates.push({ name, b: Buffer.isBuffer(b) ? b : Buffer.from(String(b), "utf8") });
}

add("nonce", nonce);
if (password) add("password", password);
add("nonce-password", `${nonce}-${password}`);
add("nonce+password", `${nonce}${password}`);

if (password) {
    const sk = deriveAesKey(nonce, password);
    add("sessionKey(raw)", sk);
    add("sessionKey(md5)", crypto.createHash("md5").update(sk).digest());
    add("nonce-password(md5)", crypto.createHash("md5").update(`${nonce}-${password}`, "utf8").digest());
}

// Common fixed IV constant seen in Reolink code.
add("fixedIv(0123456789abcdef)", "0123456789abcdef");

// Try small repeats (sometimes zlib dicts are short tokens repeated / padded).
function repeatTo(name, b, n) {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = b[i % b.length];
    add(name, out);
}

for (const { name, b } of [...candidates]) {
    if (b.length > 0) {
        repeatTo(`${name}.repeat4096`, b, 4096);
        repeatTo(`${name}.repeat8192`, b, 8192);
        repeatTo(`${name}.repeat32768`, b, 32768);
    }
}

const matches = [];
for (const c of candidates) {
    const v = adler32(c.b);
    if (v === target) matches.push({ name: c.name, len: c.b.length });
}

console.log(JSON.stringify({ targetHex: `0x${target.toString(16)}`, matchCount: matches.length, matches }, null, 2));

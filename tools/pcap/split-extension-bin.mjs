#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function main() {
    const input = process.argv[2];
    if (!input) {
        console.error("Usage: node tools/pcap/split-extension-bin.mjs <input.bin> [--out <prefix>] ");
        process.exit(2);
    }

    let outPrefix = null;
    for (let i = 3; i < process.argv.length; i++) {
        if (process.argv[i] === "--out") outPrefix = String(process.argv[++i] ?? "");
    }

    const buf = fs.readFileSync(input);

    // Heuristic: locate closing tag for Extension and split on the following newline.
    const closeTag = Buffer.from("</Extension>", "utf8");
    const closeAt = buf.indexOf(closeTag);
    if (closeAt < 0) {
        throw new Error("Could not find </Extension> in input");
    }
    let splitAt = buf.indexOf(0x0a, closeAt + closeTag.length);
    if (splitAt < 0) splitAt = closeAt + closeTag.length;
    else splitAt += 1; // include newline

    const ext = buf.subarray(0, splitAt);
    const bin = buf.subarray(splitAt);

    const base = outPrefix ?? input;
    const dir = path.dirname(base);
    fs.mkdirSync(dir, { recursive: true });

    const outExt = `${base}.extension.xml`;
    const outBin = `${base}.binonly.bin`;

    fs.writeFileSync(outExt, ext);
    fs.writeFileSync(outBin, bin);

    console.log(
        JSON.stringify(
            {
                input,
                len: buf.length,
                closeAt,
                splitAt,
                out: {
                    extension: outExt,
                    binonly: outBin,
                    binHeadHex: bin.subarray(0, 32).toString("hex"),
                },
            },
            null,
            2,
        ),
    );
}

main();

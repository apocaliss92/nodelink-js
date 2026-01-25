#!/usr/bin/env node
/**
 * Run all offline tests
 *
 * Usage: node test/run-tests.mjs [test-name]
 *
 * Examples:
 *   node test/run-tests.mjs              # Run all tests
 *   node test/run-tests.mjs video        # Run only video-stream tests
 *   node test/run-tests.mjs bcmedia      # Run only bcmedia tests
 *   node test/run-tests.mjs nvr          # Run only nvr-channels tests
 */

import { spawn } from "child_process";
import { readdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const UNIT_DIR = join(__dirname, "unit");

async function getTestFiles() {
    try {
        const files = await readdir(UNIT_DIR);
        return files
            .filter((f) => f.endsWith(".test.mjs"))
            .map((f) => join(UNIT_DIR, f));
    } catch (e) {
        console.error(`Error reading test directory: ${e.message}`);
        return [];
    }
}

async function runTest(testFile) {
    return new Promise((resolve) => {
        const proc = spawn("node", [testFile], {
            stdio: "inherit",
            cwd: join(__dirname, ".."),
        });

        proc.on("close", (code) => {
            resolve(code === 0);
        });

        proc.on("error", (err) => {
            console.error(`Failed to run ${testFile}: ${err.message}`);
            resolve(false);
        });
    });
}

async function main() {
    const filter = process.argv[2]?.toLowerCase();

    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║           REOLINK BAICHUAN OFFLINE TEST SUITE              ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");

    let testFiles = await getTestFiles();

    if (testFiles.length === 0) {
        console.error("No test files found in test/unit/");
        process.exit(1);
    }

    // Filter tests if argument provided
    if (filter) {
        testFiles = testFiles.filter((f) => f.toLowerCase().includes(filter));
        if (testFiles.length === 0) {
            console.error(`No test files matching '${filter}'`);
            process.exit(1);
        }
    }

    console.log(`Running ${testFiles.length} test file(s):\n`);

    const results = [];

    for (const testFile of testFiles) {
        const fileName = testFile.split("/").pop();
        console.log(`\n▶ Running: ${fileName}`);
        console.log("─".repeat(60));

        const success = await runTest(testFile);
        results.push({ file: fileName, success });

        if (!success) {
            console.log(`\n✗ ${fileName} FAILED\n`);
        }
    }

    // Final summary
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                      FINAL SUMMARY                         ║");
    console.log("╚════════════════════════════════════════════════════════════╝");

    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    for (const r of results) {
        const status = r.success ? "✓ PASS" : "✗ FAIL";
        console.log(`  ${status}  ${r.file}`);
    }

    console.log("");
    console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
    console.log("");

    process.exit(failed > 0 ? 1 : 0);
}

main();

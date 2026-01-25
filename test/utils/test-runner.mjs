/**
 * Simple Test Runner
 *
 * Lightweight test framework for running offline tests
 */

const testResults = {
    passed: 0,
    failed: 0,
    skipped: 0,
    tests: [],
};

let currentSuite = "";
const pendingTests = [];

export function describe(name, fn) {
    currentSuite = name;
    pendingTests.push({ type: "describe", name });
    fn();
}

export function it(name, fn) {
    const suiteName = currentSuite;
    pendingTests.push({ type: "test", name, fn, suite: suiteName });
}

async function runPendingTests() {
    let currentSuiteName = "";

    for (const item of pendingTests) {
        if (item.type === "describe") {
            currentSuiteName = item.name;
            console.log(`\n📦 ${item.name}`);
        } else if (item.type === "test") {
            const fullName = `${item.suite} > ${item.name}`;
            try {
                await item.fn();
                testResults.passed++;
                testResults.tests.push({ name: fullName, status: "passed" });
                console.log(`  ✅ ${item.name}`);
            } catch (err) {
                testResults.failed++;
                testResults.tests.push({
                    name: fullName,
                    status: "failed",
                    error: err.message,
                });
                console.log(`  ❌ ${item.name}`);
                console.log(`     Error: ${err.message}`);
            }
        }
    }
}

export function skip(name, _fn) {
    const fullName = `${currentSuite} > ${name}`;
    testResults.skipped++;
    testResults.tests.push({ name: fullName, status: "skipped" });
    console.log(`  ⏭️  ${name} (skipped)`);
}

export function assert(condition, message) {
    if (!condition) {
        throw new Error(message || "Assertion failed");
    }
}

export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(
            message || `Expected ${expected}, got ${actual}`
        );
    }
}

export function assertGreater(actual, min, message) {
    if (actual <= min) {
        throw new Error(
            message || `Expected ${actual} to be greater than ${min}`
        );
    }
}

export function assertArrayLength(arr, minLength, message) {
    if (!arr || arr.length < minLength) {
        throw new Error(
            message ||
            `Expected array length >= ${minLength}, got ${arr?.length || 0}`
        );
    }
}

export function assertDefined(value, message) {
    if (value === undefined || value === null) {
        throw new Error(message || "Expected value to be defined");
    }
}

export function assertTruthy(value, message) {
    if (!value) {
        throw new Error(message || "Expected truthy value");
    }
}

export async function printSummary() {
    await runPendingTests();

    console.log("\n" + "═".repeat(60));
    console.log("Test Summary");
    console.log("═".repeat(60));
    console.log(`  ✅ Passed:  ${testResults.passed}`);
    console.log(`  ❌ Failed:  ${testResults.failed}`);
    console.log(`  ⏭️  Skipped: ${testResults.skipped}`);
    console.log("═".repeat(60));

    if (testResults.failed > 0) {
        console.log("\nFailed tests:");
        for (const t of testResults.tests.filter((t) => t.status === "failed")) {
            console.log(`  - ${t.name}: ${t.error}`);
        }
    }

    return testResults.failed === 0;
}

export function getResults() {
    return testResults;
}

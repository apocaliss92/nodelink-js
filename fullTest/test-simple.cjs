// Test file creation
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'downloads', 'bcmedia-dump');

// Log to both console and file
const logFile = path.join(outDir, 'test_output.log');
const log = [];

function logMsg(msg) {
    console.log(msg);
    log.push(msg);
}

try {
    logMsg('Script started');
    logMsg(`outDir: ${outDir}`);
    logMsg(`outDir exists: ${fs.existsSync(outDir)}`);

    // List files
    const files = fs.readdirSync(outDir);
    logMsg(`Files in outDir: ${files.join(', ')}`);

    // Check frame file
    const keyFile = path.join(outDir, 'frame_1_key.h264');
    logMsg(`keyFile: ${keyFile}`);
    logMsg(`keyFile exists: ${fs.existsSync(keyFile)}`);

    if (fs.existsSync(keyFile)) {
        const buf = fs.readFileSync(keyFile);
        logMsg(`keyFile size: ${buf.length}`);
        logMsg(`First 32 bytes: ${buf.subarray(0, 32).toString('hex')}`);

        // Check NAL structure
        if (buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1) {
            const nalType = buf[4] & 0x1F;
            logMsg(`Valid 4-byte start code, NAL type: ${nalType}`);
        } else if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1) {
            const nalType = buf[3] & 0x1F;
            logMsg(`Valid 3-byte start code, NAL type: ${nalType}`);
        } else {
            logMsg('NO VALID START CODE!');
        }
    }

} catch (e) {
    logMsg(`Error: ${e.message}`);
    logMsg(e.stack);
} finally {
    // Always try to write log
    try {
        fs.writeFileSync(logFile, log.join('\n'));
        console.log('Log written to:', logFile);
    } catch (writeErr) {
        console.error('Failed to write log:', writeErr.message);
    }
}

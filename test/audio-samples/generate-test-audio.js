#!/usr/bin/env node
/**
 * Generates a test audio file in WAV format (PCM 16-bit, 8kHz, mono).
 * Generates a 1-second test tone.
 */

import { writeFileSync } from "node:fs";

// Generate a 440Hz sine tone for 1 second.
// Sample rate: 8000 Hz
// Bit depth: 16-bit
// Channels: 1 (mono)

const sampleRate = 8000;
const duration = 1; // seconds
const frequency = 440; // Hz (A4)
const amplitude = 0.3; // Volume (30%)

const numSamples = sampleRate * duration;
const samples = [];

for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate;
  const sample = Math.sin(2 * Math.PI * frequency * t) * amplitude;
  // Convert to 16-bit PCM (-32768 to 32767)
  const pcmSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  samples.push(pcmSample);
}

// Create WAV header
const header = Buffer.alloc(44);
let offset = 0;

// RIFF header
header.write("RIFF", offset); offset += 4;
header.writeUInt32LE(36 + samples.length * 2, offset); offset += 4; // File size - 8
header.write("WAVE", offset); offset += 4;

// fmt chunk
header.write("fmt ", offset); offset += 4;
header.writeUInt32LE(16, offset); offset += 4; // fmt chunk size
header.writeUInt16LE(1, offset); offset += 2; // Audio format (1 = PCM)
header.writeUInt16LE(1, offset); offset += 2; // Number of channels (1 = mono)
header.writeUInt32LE(sampleRate, offset); offset += 4; // Sample rate
header.writeUInt32LE(sampleRate * 2, offset); offset += 4; // Byte rate
header.writeUInt16LE(2, offset); offset += 2; // Block align
header.writeUInt16LE(16, offset); offset += 2; // Bits per sample

// data chunk
header.write("data", offset); offset += 4;
header.writeUInt32LE(samples.length * 2, offset); offset += 4; // Data size

// Convert samples to buffer (little-endian 16-bit)
const audioData = Buffer.alloc(samples.length * 2);
for (let i = 0; i < samples.length; i++) {
  audioData.writeInt16LE(samples[i], i * 2);
}

// Combine header + data
const wavFile = Buffer.concat([header, audioData]);

// Write file
writeFileSync("test-tone.wav", wavFile);
console.log(`[OK] Created test-tone.wav: ${wavFile.length} bytes`);
console.log(`   Sample rate: ${sampleRate} Hz`);
console.log(`   Duration: ${duration} seconds`);
console.log(`   Frequency: ${frequency} Hz`);
console.log(`   Format: PCM 16-bit mono`);


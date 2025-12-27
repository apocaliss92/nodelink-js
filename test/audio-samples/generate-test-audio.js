#!/usr/bin/env node
/**
 * Genera un file audio di test in formato WAV (PCM 16-bit, 8kHz, mono)
 * Genera un tono di test di 1 secondo
 */

import { writeFileSync } from "node:fs";

// Genera un tono sinusoidale a 440Hz (La) per 1 secondo
// Sample rate: 8000 Hz
// Bit depth: 16-bit
// Channels: 1 (mono)

const sampleRate = 8000;
const duration = 1; // secondi
const frequency = 440; // Hz (La)
const amplitude = 0.3; // Volume (30%)

const numSamples = sampleRate * duration;
const samples = [];

for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate;
  const sample = Math.sin(2 * Math.PI * frequency * t) * amplitude;
  // Converti a 16-bit PCM (-32768 a 32767)
  const pcmSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  samples.push(pcmSample);
}

// Crea header WAV
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

// Converti samples a buffer (little-endian 16-bit)
const audioData = Buffer.alloc(samples.length * 2);
for (let i = 0; i < samples.length; i++) {
  audioData.writeInt16LE(samples[i], i * 2);
}

// Combina header e dati
const wavFile = Buffer.concat([header, audioData]);

// Salva file
writeFileSync("test-tone.wav", wavFile);
console.log(`✅ Creato test-tone.wav: ${wavFile.length} bytes`);
console.log(`   Sample rate: ${sampleRate} Hz`);
console.log(`   Durata: ${duration} secondi`);
console.log(`   Frequenza: ${frequency} Hz`);
console.log(`   Formato: PCM 16-bit mono`);


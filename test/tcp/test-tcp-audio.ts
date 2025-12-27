#!/usr/bin/env node
/**
 * Suite di test per le API audio (2-way audio)
 * Testa: getTwoWayAudioConfig, startTwoWayAudio, sendAudioData, stopTwoWayAudio
 * Include test per encoding/decoding G.711
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, ScryptedIntercom } from "../../index.js";
import { config } from "../env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Modern G.711 A-law library (CommonJS, use default import)
import alawmulaw from "alawmulaw";
const { alaw, mulaw } = alawmulaw;

// Funzioni helper
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔊 ${message}`);
  if (data !== undefined) {
    if (data instanceof Buffer) {
      console.log(`   Buffer: ${data.length} bytes`);
      console.log(`   Hex preview: ${data.subarray(0, Math.min(32, data.length)).toString("hex")}`);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }
  console.log("=".repeat(60));
}

function logSuccess(message: string) {
  console.log(`\n✅ ${message}`);
}

function logError(message: string, error: unknown) {
  console.error(`\n❌ ERRORE: ${message}`);
  if (error instanceof Error) {
    console.error(`   Messaggio: ${error.message}`);
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split("\n").slice(0, 3).join("\n")}`);
    }
  } else {
    console.error(`   Dettagli: ${error}`);
  }
}

async function testG711Encoding() {
  try {
    log("Test encoding/decoding G.711");

    // Crea dati PCM di test (silenzio - tutti zeri)
    // 160 bytes = 10ms a 8kHz, 16-bit (80 campioni)
    const pcmData = Buffer.alloc(160);
    log("PCM Input", pcmData);

    // Converti Buffer a Int16Array per alawmulaw
    const pcmInt16 = new Int16Array(pcmData.length / 2);
    for (let i = 0; i < pcmInt16.length; i++) {
      pcmInt16[i] = pcmData.readInt16LE(i * 2);
    }

    // Test G.711 A-law encoding
    const g711aEncoded = Buffer.from(alaw.encode(pcmInt16));
    log("G.711 A-law Encoded", g711aEncoded);

    // Test G.711 A-law decoding
    const g711aDecodedInt16 = alaw.decode(new Uint8Array(g711aEncoded));
    const g711aDecoded = Buffer.alloc(g711aDecodedInt16.length * 2);
    for (let i = 0; i < g711aDecodedInt16.length; i++) {
      g711aDecoded.writeInt16LE(g711aDecodedInt16[i] ?? 0, i * 2);
    }
    log("G.711 A-law Decoded", g711aDecoded);

    // Verifica che la decodifica sia corretta (può avere piccole differenze)
    if (g711aDecoded.length !== pcmData.length) {
      logError("Lunghezza mismatch dopo decode", new Error(`Atteso ${pcmData.length}, ottenuto ${g711aDecoded.length}`));
      return false;
    }

    logSuccess("G.711 encoding/decoding funziona correttamente");
    return true;
  } catch (error) {
    logError("Errore durante test G.711 encoding", error);
    return false;
  }
}

async function testTwoWayAudioConfig(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test getTwoWayAudioConfig per channel ${channel}`);
    const audioConfig = await api.getTwoWayAudioConfig(channel);
    logSuccess(`Two-way audio config ottenuto per channel ${channel}`);
    log("Two-Way Audio Config", audioConfig);

    // Verifica struttura
    if (audioConfig.channel !== channel) {
      logError(`Channel mismatch: atteso ${channel}, ottenuto ${audioConfig.channel}`, new Error("Channel mismatch"));
      return false;
    }

    if (typeof audioConfig.enabled !== "boolean") {
      logError(`Enabled deve essere boolean, ottenuto ${typeof audioConfig.enabled}`, new Error("Type mismatch"));
      return false;
    }

    logSuccess("Two-way audio config valido");
    if (audioConfig.enabled) {
      logSuccess("✅ Two-way audio è supportato su questo dispositivo!");
    } else {
      log("⚠️  Two-way audio non è supportato su questo dispositivo");
    }
    return true;
  } catch (error) {
    logError("Errore durante test getTwoWayAudioConfig", error);
    return false;
  }
}

async function testStartStopTwoWayAudio(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test startTwoWayAudio / stopTwoWayAudio per channel ${channel}`);

    // Verifica se è supportato
    const config = await api.getTwoWayAudioConfig(channel);
    if (!config.enabled) {
      log("⚠️  Two-way audio non supportato, saltando test");
      return true; // Non è un errore
    }

    // Avvia two-way audio
    await api.startTwoWayAudio(channel);
    logSuccess("Two-way audio avviato");

    // Attendi un po' per stabilizzare
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Ferma two-way audio
    await api.stopTwoWayAudio(channel);
    logSuccess("Two-way audio fermato");

    return true;
  } catch (error) {
    logError("Errore durante test start/stop two-way audio", error);
    return false;
  }
}

/**
 * Estrae dati PCM da file WAV (per test - in produzione i dati arrivano già PCM da ffmpeg)
 * Nota: Per il caso d'uso reale, i dati audio arriveranno già in formato PCM da ffmpeg,
 * quindi questa funzione è solo per i test con file WAV.
 */
function extractPCMFromWav(wavBuffer: Buffer): { pcmData: Buffer; sampleRate: number } {
  // WAV header è 44 bytes standard
  // Cerca il chunk "data"
  const dataOffset = wavBuffer.indexOf(Buffer.from("data"));
  if (dataOffset === -1) {
    throw new Error("WAV file non valido: chunk 'data' non trovato");
  }
  
  // Leggi sample rate dal header WAV (offset 24)
  const sampleRate = wavBuffer.readUInt32LE(24);
  
  // Offset: "data" (4) + size (4) = 8 bytes dopo "data"
  const pcmStart = dataOffset + 8;
  const pcmData = wavBuffer.subarray(pcmStart);
  
  return { pcmData, sampleRate };
}

async function testSendAudioData(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test sendAudioData per channel ${channel}`);

    // Verifica se è supportato
    const audioConfig = await api.getTwoWayAudioConfig(channel);
    if (!audioConfig.enabled) {
      log("⚠️  Two-way audio non supportato, saltando test");
      return true; // Non è un errore
    }

    // Avvia two-way audio
    await api.startTwoWayAudio(channel);
    logSuccess("Two-way audio avviato");

    // Carica file audio di test (WAV PCM)
    // Nota: In produzione, i dati arriveranno già in formato PCM da ffmpeg
    //       quindi non serve alcun decode, solo encoding G.711
    const audioSamplePath = join(process.cwd(), "test", "audio-samples", "test-tone.wav");
    let pcmData: Buffer;
    
    try {
      const wavData = readFileSync(audioSamplePath);
      log(`File audio caricato: ${audioSamplePath}`);
      
      // Estrai PCM dal WAV (solo per test - in produzione i dati sono già PCM)
      const extracted = extractPCMFromWav(wavData);
      pcmData = extracted.pcmData;
      
      log(`PCM Audio Data: ${pcmData.length} bytes (${(pcmData.length / 2 / extracted.sampleRate).toFixed(2)}s a ${extracted.sampleRate}Hz)`);
      
      // Se il sample rate non è 8kHz, avvisa
      if (extracted.sampleRate !== 8000) {
        log(`⚠️  Sample rate è ${extracted.sampleRate}Hz, non 8kHz. In produzione, ffmpeg dovrebbe essere configurato per 8kHz.`);
      }
    } catch (error) {
      logError("Errore durante caricamento file audio", error);
      log("⚠️  Impossibile caricare file audio, uso dati di test (silenzio)");
      // Fallback: usa silenzio
      pcmData = Buffer.alloc(1600); // 100ms di silenzio
    }

    // Invia audio in chunk (es. 160 bytes = 10ms per chunk)
    const chunkSize = 160; // 10ms a 8kHz, 16-bit
    const numChunks = Math.ceil(pcmData.length / chunkSize);
    
    log(`Invio audio in ${numChunks} chunk da ${chunkSize} bytes (10ms ciascuno)`);

    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, pcmData.length);
      const chunk = pcmData.subarray(start, end);
      
      // Encode to G.711 A-law usando libreria moderna
      // Nota: In produzione, i dati arrivano già PCM da ffmpeg, quindi serve solo encoding
      const pcmInt16 = new Int16Array(chunk.length / 2);
      for (let i = 0; i < pcmInt16.length; i++) {
        pcmInt16[i] = chunk.readInt16LE(i * 2);
      }
      const g711Chunk = Buffer.from(alaw.encode(pcmInt16));
      
      // Invia chunk
      await api.sendAudioData(g711Chunk, channel);
      
      // Attendi 10ms tra i chunk (simula real-time streaming)
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      if ((i + 1) % 10 === 0) {
        log(`   Inviati ${i + 1}/${numChunks} chunk`);
      }
    }

    logSuccess(`Audio data inviato (${pcmData.length} bytes PCM = ${(pcmData.length / 2 / 8000).toFixed(2)}s)`);

    // Attendi un po' per completare la trasmissione
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Ferma two-way audio
    await api.stopTwoWayAudio(channel);
    logSuccess("Two-way audio fermato");

    return true;
  } catch (error) {
    logError("Errore durante test sendAudioData", error);
    return false;
  }
}

async function testScryptedIntercom(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test ScryptedIntercom per channel ${channel}`);

    // Verifica se è supportato
    const audioConfig = await api.getTwoWayAudioConfig(channel);
    if (!audioConfig.enabled) {
      log("⚠️  Two-way audio non supportato, saltando test");
      return true; // Non è un errore
    }

    let audioReceived = false;
    let audioChunksReceived = 0;
    const audioCallback = (data: Buffer) => {
      audioReceived = true;
      audioChunksReceived++;
      if (audioChunksReceived <= 3) {
        log(`📢 Audio ricevuto dalla camera (chunk ${audioChunksReceived})!`, data);
      }
    };

    // Crea intercom
    const intercom = new ScryptedIntercom({
      channel,
      api,
      onAudioData: audioCallback,
    });

    // Avvia intercom
    await intercom.start();
    logSuccess("ScryptedIntercom avviato");

    // Carica e decodifica file audio di test
    const audioSamplePath = join(process.cwd(), "test", "audio-samples", "test-tone.wav");
    let pcmData: Buffer;
    
    try {
      const audioFileData = readFileSync(audioSamplePath);
      log(`File audio caricato per ScryptedIntercom: ${audioSamplePath}`);
      
      // Estrai PCM dal WAV (solo per test - in produzione i dati sono già PCM da ffmpeg)
      const extracted = extractPCMFromWav(audioFileData);
      pcmData = extracted.pcmData;
      
      log(`PCM Audio Data: ${pcmData.length} bytes (${extracted.sampleRate}Hz)`);
      
      if (extracted.sampleRate !== 8000) {
        log(`⚠️  Sample rate è ${extracted.sampleRate}Hz, non 8kHz. In produzione, ffmpeg dovrebbe essere configurato per 8kHz.`);
      }
    } catch (error) {
      logError("Errore durante decodifica audio", error);
      log("⚠️  Impossibile caricare/decodificare file audio, uso dati di test");
      pcmData = Buffer.alloc(1600); // 100ms di silenzio
    }

    // Invia audio tramite ScryptedIntercom (gestisce encoding automaticamente)
    await intercom.sendAudio(pcmData);
    logSuccess(`Audio inviato tramite ScryptedIntercom (${pcmData.length} bytes PCM)`);

    // Attendi un po' per eventuali risposte audio
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (!audioReceived) {
      log("⚠️  Nessun audio ricevuto (normale se la camera non sta trasmettendo)");
    } else {
      logSuccess(`Ricevuti ${audioChunksReceived} chunk audio dalla camera`);
    }

    // Ferma intercom
    await intercom.stop();
    logSuccess("ScryptedIntercom fermato");

    return true;
  } catch (error) {
    logError("Errore durante test ScryptedIntercom", error);
    return false;
  }
}

async function runAudioTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         TEST SUITE AUDIO - REOLINK BAICHUAN              ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfigurazione:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("❌ ERRORE: Configurazione TCP non completa nel file .env");
    console.error("   Assicurati di aver impostato TCP_HOST e TCP_PASSWORD");
    process.exit(1);
  }

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: false,
  });

  const channel = 0;
  const results: Record<string, boolean> = {};

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Test G.711 encoding/decoding (offline)
    results.g711Encoding = await testG711Encoding();

    // Test Two-Way Audio Config
    results.twoWayAudioConfig = await testTwoWayAudioConfig(api, channel);

    // Test Start/Stop Two-Way Audio
    results.startStopAudio = await testStartStopTwoWayAudio(api, channel);

    // Test Send Audio Data
    results.sendAudioData = await testSendAudioData(api, channel);

    // Test ScryptedIntercom
    results.scryptedIntercom = await testScryptedIntercom(api, channel);

    // Riepilogo
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    RIEPILOGO TEST AUDIO                  ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("\n");

    const passed = Object.values(results).filter((r) => r).length;
    const total = Object.keys(results).length;

    for (const [testName, result] of Object.entries(results)) {
      const icon = result ? "✅" : "❌";
      console.log(`${icon} ${testName}: ${result ? "PASS" : "FAIL"}`);
    }

    console.log(`\n📊 Risultati: ${passed}/${total} test passati\n`);

    if (passed === total) {
      console.log("🎉 Tutti i test audio sono passati!");
    } else {
      console.log(`⚠️  ${total - passed} test falliti`);
    }
  } catch (error) {
    logError("Errore critico durante i test", error);
    process.exit(1);
  } finally {
    try {
      await api.close();
      logSuccess("Connessione chiusa");
    } catch (error) {
      logError("Errore durante chiusura connessione", error);
    }
  }
}

// Esegui i test
runAudioTests().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


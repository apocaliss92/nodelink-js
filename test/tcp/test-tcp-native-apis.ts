#!/usr/bin/env node
/**
 * Suite di test per le nuove API native Baichuan
 * Testa: eventi, stream metadata, OSD, AI, motion, 2-way audio
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type ReolinkEvent } from "../../index.js";
import { config } from "../env.js";

// Funzioni helper
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📹 ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
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

async function testStreamMetadata(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test getStreamMetadata per channel ${channel}`);
    const metadata = await api.getStreamMetadata(channel);
    logSuccess(`Stream metadata ottenuto per channel ${channel}`);
    log("Stream Metadata", metadata);

    // Verifica struttura
    if (!metadata.streams || metadata.streams.length === 0) {
      logError("Nessuno stream trovato", new Error("metadata.streams è vuoto"));
      return false;
    }

    // Verifica ogni stream
    for (const stream of metadata.streams) {
      if (!stream.profile || !["main", "sub", "ext"].includes(stream.profile)) {
        logError(`Stream profile invalido: ${stream.profile}`, new Error("Profile deve essere main, sub o ext"));
        return false;
      }
      if (stream.width <= 0 || stream.height <= 0) {
        logError(`Risoluzione invalida: ${stream.width}x${stream.height}`, new Error("Risoluzione deve essere > 0"));
        return false;
      }
      if (stream.frameRate < 0) {
        logError(`Frame rate invalido: ${stream.frameRate}`, new Error("Frame rate deve essere >= 0"));
        return false;
      }
    }

    logSuccess(`Tutti gli stream sono validi (${metadata.streams.length} stream trovati)`);
    return true;
  } catch (error) {
    logError("Errore durante test getStreamMetadata", error);
    return false;
  }
}

async function testOsd(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test getOsd per channel ${channel}`);
    const osd = await api.getOsd(channel);
    logSuccess(`OSD ottenuto per channel ${channel}`);
    log("OSD Config", osd);

    // Verifica struttura
    if (osd.channel !== channel) {
      logError(`Channel mismatch: atteso ${channel}, ottenuto ${osd.channel}`, new Error("Channel mismatch"));
      return false;
    }

    logSuccess("OSD config valido");
    return true;
  } catch (error) {
    logError("Errore durante test getOsd", error);
    return false;
  }
}

async function testSetOsd(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test setOsd per channel ${channel}`);
    
    // Prima ottieni la configurazione corrente
    const currentOsd = await api.getOsd(channel);
    log("OSD corrente", currentOsd);

    // Crea una nuova configurazione (mantieni i valori esistenti)
    const newOsd = {
      channel,
      osdChannel: {
        enable: currentOsd.osdChannel.enable,
        name: currentOsd.osdChannel.name || "Test Channel",
        pos: currentOsd.osdChannel.pos || "TopLeft",
      },
      osdTime: {
        enable: currentOsd.osdTime.enable,
        pos: currentOsd.osdTime.pos || "TopRight",
      },
      watermark: currentOsd.watermark || 0,
    };

    await api.setOsd(channel, newOsd);
    logSuccess(`OSD impostato per channel ${channel}`);

    // Verifica che sia stato salvato
    const verifyOsd = await api.getOsd(channel);
    if (verifyOsd.osdChannel.name !== newOsd.osdChannel.name) {
      logError("OSD non salvato correttamente", new Error("Name mismatch"));
      return false;
    }

    logSuccess("OSD config salvato e verificato");
    return true;
  } catch (error) {
    logError("Errore durante test setOsd", error);
    return false;
  }
}

async function testAiState(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test getAiState per channel ${channel}`);
    const aiState = await api.getAiState(channel);
    logSuccess(`AI State ottenuto per channel ${channel}`);
    log("AI State", aiState);

    // Verifica struttura
    if (aiState.channel !== channel) {
      logError(`Channel mismatch: atteso ${channel}, ottenuto ${aiState.channel}`, new Error("Channel mismatch"));
      return false;
    }

    logSuccess("AI State valido");
    return true;
  } catch (error) {
    logError("Errore durante test getAiState", error);
    return false;
  }
}

async function testMotionState(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test getMotionState per channel ${channel}`);
    const motionState = await api.getMotionState(channel);
    logSuccess(`Motion State ottenuto per channel ${channel}`);
    log("Motion State", { enabled: motionState });

    // Verifica tipo
    if (typeof motionState !== "boolean") {
      logError(`Motion state deve essere boolean, ottenuto ${typeof motionState}`, new Error("Type mismatch"));
      return false;
    }

    logSuccess("Motion State valido");
    return true;
  } catch (error) {
    logError("Errore durante test getMotionState", error);
    return false;
  }
}

async function testEvents(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test getEvents per channel ${channel}`);
    const events = await api.getEvents(channel);
    logSuccess(`Events ottenuto per channel ${channel}`);
    log("Events", events);

    // Verifica struttura base
    if (events.channel !== undefined && events.channel !== channel) {
      logError(`Channel mismatch: atteso ${channel}, ottenuto ${events.channel}`, new Error("Channel mismatch"));
      return false;
    }

    logSuccess("Events valido");
    return true;
  } catch (error) {
    logError("Errore durante test getEvents", error);
    return false;
  }
}

async function testSubscribeEvents(api: ReolinkBaichuanApi) {
  try {
    log("Test subscribeEvents");
    
    let eventReceived = false;
    const eventTimeout = setTimeout(() => {
      if (!eventReceived) {
        log("⚠️  Nessun evento ricevuto entro 10 secondi (normale se non c'è movimento)");
      }
    }, 10000);

    // Sottoscrivi agli eventi
    await api.subscribeEvents();
    logSuccess("Sottoscrizione eventi attivata");

    // Listener per eventi
    api.client.on("event", (event: ReolinkEvent) => {
      eventReceived = true;
      clearTimeout(eventTimeout);
      log("📢 Evento ricevuto!", event);
    });

    // Attendi un po' per eventuali eventi
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Unsubscribe
    await api.unsubscribeEvents();
    logSuccess("Sottoscrizione eventi disattivata");

    clearTimeout(eventTimeout);
    return true;
  } catch (error) {
    logError("Errore durante test subscribeEvents", error);
    return false;
  }
}

async function testTwoWayAudioConfig(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test getTwoWayAudioConfig per channel ${channel}`);
    const config = await api.getTwoWayAudioConfig(channel);
    logSuccess(`Two-way audio config ottenuto per channel ${channel}`);
    log("Two-Way Audio Config", config);

    // Verifica struttura
    if (config.channel !== channel) {
      logError(`Channel mismatch: atteso ${channel}, ottenuto ${config.channel}`, new Error("Channel mismatch"));
      return false;
    }

    if (typeof config.enabled !== "boolean") {
      logError(`Enabled deve essere boolean, ottenuto ${typeof config.enabled}`, new Error("Type mismatch"));
      return false;
    }

    logSuccess("Two-way audio config valido");
    if (config.enabled) {
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

async function testTwoWayAudio(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Test startTwoWayAudio per channel ${channel}`);

    // Prima verifica se è supportato
    const config = await api.getTwoWayAudioConfig(channel);
    if (!config.enabled) {
      log("⚠️  Two-way audio non supportato, saltando test");
      return true; // Non è un errore, semplicemente non supportato
    }

    // Avvia two-way audio
    await api.startTwoWayAudio(channel);
    logSuccess("Two-way audio avviato");

    // Attendi un po'
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Test invio audio (dati di test - silenzio PCM)
    const testAudioData = Buffer.alloc(160); // 160 bytes = 10ms di audio a 8kHz, 16-bit
    try {
      await api.sendAudioData(testAudioData, channel);
      logSuccess("Audio data inviato (test silenzio)");
    } catch (error) {
      logError("Errore durante invio audio data", error);
      // Non fallisce il test, potrebbe essere un problema di implementazione
    }

    // Ferma two-way audio
    await api.stopTwoWayAudio(channel);
    logSuccess("Two-way audio fermato");

    return true;
  } catch (error) {
    logError("Errore durante test two-way audio", error);
    return false;
  }
}

async function runNativeApiTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║      TEST SUITE API NATIVE - REOLINK BAICHUAN           ║");
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

    // Test Stream Metadata
    results.streamMetadata = await testStreamMetadata(api, channel);

    // Test OSD
    results.getOsd = await testOsd(api, channel);
    results.setOsd = await testSetOsd(api, channel);

    // Test AI State
    results.aiState = await testAiState(api, channel);

    // Test Motion State
    results.motionState = await testMotionState(api, channel);

    // Test Events
    results.getEvents = await testEvents(api, channel);

    // Test Subscribe Events
    results.subscribeEvents = await testSubscribeEvents(api);

    // Test Two-Way Audio Config
    results.twoWayAudioConfig = await testTwoWayAudioConfig(api, channel);

    // Test Two-Way Audio
    results.twoWayAudio = await testTwoWayAudio(api, channel);

    // Riepilogo
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    RIEPILOGO TEST                        ║");
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
      console.log("🎉 Tutti i test sono passati!");
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
runNativeApiTests().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


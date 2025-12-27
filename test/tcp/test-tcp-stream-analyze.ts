#!/usr/bin/env node
/**
 * Analisi stream video Baichuan - Analizza i push events per identificare i frame video
 * Questo script si connette al dispositivo TCP e analizza tutti i frame ricevuti
 * per capire come funziona lo streaming video via Baichuan.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index.js";
import { config } from "../env.js";

// Funzioni helper
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 ${message}`);
  if (data !== undefined) {
    if (data instanceof Buffer) {
      console.log(`   Buffer: ${data.length} bytes`);
      console.log(`   Hex preview (first 64 bytes): ${data.subarray(0, Math.min(64, data.length)).toString("hex")}`);
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

interface FrameStats {
  cmdId: number;
  streamType: number;
  channelId: number;
  bodyLen: number;
  count: number;
  samples: BaichuanFrame[];
  isXml: boolean;
  isBinary: boolean;
  firstBytes: string;
}

async function analyzeBaichuanStream() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     ANALISI STREAM VIDEO BAICHUAN (TCP)                  ║");
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
  const frameStats = new Map<string, FrameStats>();
  const analysisDuration = 30000; // 30 secondi di analisi (più tempo per catturare frame video)

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Ottieni metadati stream per capire quali stream sono disponibili
    log(`Ottengo metadati stream per channel ${channel}`);
    const metadata = await api.getStreamMetadata(channel);
    logSuccess(`Stream disponibili: ${metadata.streams.length}`);
    for (const stream of metadata.streams) {
      log(`Stream ${stream.profile.toUpperCase()}`, {
        profile: stream.profile,
        resolution: `${stream.width}x${stream.height}`,
        fps: stream.frameRate,
        codec: stream.videoEncType,
        bitrate: `${stream.bitRate} kbps`,
        audio: stream.audio === 1 ? "Sì" : "No",
      });
    }

    // Ascolta tutti i push events
    log(`Inizio analisi push events per ${analysisDuration / 1000} secondi...`);
    log("⚠️  Assicurati che ci sia attività video sulla camera (movimento, etc.)");
    
    const startTime = Date.now();
    let totalFrames = 0;

    api.client.on("push", (frame: BaichuanFrame) => {
      totalFrames++;
      
      const key = `${frame.header.cmdId}:${frame.header.streamType}:${frame.header.channelId}`;
      
      if (!frameStats.has(key)) {
        const bodyStr = frame.body.toString("utf8", 0, Math.min(100, frame.body.length));
        const isXml = bodyStr.startsWith("<?xml") || bodyStr.startsWith("<");
        
        frameStats.set(key, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
          count: 0,
          samples: [],
          isXml,
          isBinary: !isXml,
          firstBytes: frame.body.subarray(0, Math.min(32, frame.body.length)).toString("hex"),
        });
      }

      const stats = frameStats.get(key)!;
      stats.count++;
      
      // Mantieni solo i primi 3 campioni per ogni tipo di frame
      if (stats.samples.length < 3) {
        stats.samples.push(frame);
      }
    });

    // Attendi per la raccolta dati
    await new Promise((resolve) => setTimeout(resolve, analysisDuration));

    // Risultati analisi
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║              RISULTATI ANALISI FRAME                      ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\n📊 Frame totali ricevuti: ${totalFrames}`);
    console.log(`📊 Tipi di frame unici: ${frameStats.size}\n`);

    // Ordina per count (più frequenti prima)
    const sortedStats = Array.from(frameStats.values()).sort((a, b) => b.count - a.count);

    for (const stats of sortedStats) {
      log(`Frame Type: cmdId=${stats.cmdId}, streamType=${stats.streamType}, channelId=${stats.channelId}`, {
        count: stats.count,
        bodyLen: stats.bodyLen,
        type: stats.isXml ? "XML" : stats.isBinary ? "Binary" : "Unknown",
        firstBytes: stats.firstBytes,
        percentage: `${((stats.count / totalFrames) * 100).toFixed(2)}%`,
      });

      // Analisi più dettagliata per frame binari (probabilmente video)
      // Analizza tutti i frame binari per capire meglio
      if (stats.isBinary && stats.bodyLen > 50) {
        log(`   🔍 Analisi dettagliata frame binario (possibile video)`);
        
        const sample = stats.samples[0];
        if (sample) {
          // Prova a decriptare
          try {
            const decrypted = api.client.tryDecryptBinary(
              sample.body,
              sample.header.channelId,
              api.client.enc
            );
            
            log(`   Decrypted body length: ${decrypted.length} bytes`);
            log(`   Decrypted first 64 bytes (hex): ${decrypted.subarray(0, Math.min(64, decrypted.length)).toString("hex")}`);
            
            // Cerca pattern H.264/H.265 (NAL unit start codes: 0x00000001 o 0x000001)
            const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
            const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
            
            if (nalStart1 !== -1 || nalStart2 !== -1) {
              logSuccess(`   ✅ Trovato pattern NAL unit (possibile frame video H.264/H.265)!`);
              log(`   NAL start code posizione: ${nalStart1 !== -1 ? nalStart1 : nalStart2}`);
              
              // Analizza NAL unit type
              const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
              if (nalPos < decrypted.length) {
                const nalType = decrypted[nalPos]! & 0x1F;
                log(`   NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : "Other"})`);
              }
            } else {
              log(`   ⚠️  Nessun pattern NAL unit trovato (potrebbe essere incapsulato)`);
            }
          } catch (error) {
            logError(`   Errore durante decriptazione`, error);
          }
        }
      }
    }

    // Identifica possibili frame video
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║           IDENTIFICAZIONE FRAME VIDEO                     ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    
    const possibleVideoFrames = sortedStats.filter((s) => {
      return s.isBinary && 
             s.bodyLen > 50 && // Ridotto threshold per catturare più frame
             s.streamType === 0; // streamType 0 probabilmente è video
    });

    if (possibleVideoFrames.length > 0) {
      logSuccess(`Trovati ${possibleVideoFrames.length} possibili tipi di frame video:`);
      for (const frame of possibleVideoFrames) {
        log(`Frame Video Candidato`, {
          cmdId: frame.cmdId,
          streamType: frame.streamType,
          channelId: frame.channelId,
          count: frame.count,
          avgBodyLen: frame.bodyLen,
        });
      }
    } else {
      log("⚠️  Nessun frame video identificato. Prova ad aumentare il tempo di analisi o assicurati che ci sia attività video.");
    }

    // Suggerimenti
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    SUGGERIMENTI                            ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("\nPer identificare lo stream video:");
    console.log("1. I frame video hanno probabilmente:");
    console.log("   - streamType = 0 (video)");
    console.log("   - body binario (non XML)");
    console.log("   - dimensione significativa (>100 bytes)");
    console.log("   - cmd_id specifico (da identificare)");
    console.log("\n2. I frame video contengono NAL units H.264/H.265");
    console.log("   - Pattern: 0x00000001 o 0x000001");
    console.log("   - Potrebbero essere incapsulati in un header Baichuan");
    console.log("\n3. Per richiedere lo stream video, potrebbe essere necessario:");
    console.log("   - Inviare un comando specifico (cmd_id da identificare)");
    console.log("   - Specificare il profilo stream (main/sub/ext)");
    console.log("   - I frame video arrivano poi come push events\n");

  } catch (error) {
    logError("Errore critico durante l'analisi", error);
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

// Esegui l'analisi
analyzeBaichuanStream().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


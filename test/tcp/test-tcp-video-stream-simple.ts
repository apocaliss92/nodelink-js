#!/usr/bin/env node
/**
 * Test semplificato per lo streaming video via Baichuan
 * Focus su cmd_id 3 con diverse varianti di parametri
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame, buildChannelExtensionXml } from "../../index.js";
import { config } from "../env.js";

// Funzioni helper
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 ${message}`);
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
  } else {
    console.error(`   Dettagli: ${error}`);
  }
}

async function testVideoStreamSimple() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST STREAM VIDEO BAICHUAN - VERSIONE SEMPLIFICATA    ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfigurazione:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("❌ ERRORE: Configurazione TCP non completa nel file .env");
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
  const channelId = channel + 1;

  const videoFrames: BaichuanFrame[] = [];
  let pushEventCount = 0;

  // Handler per push events - cerca frame video con cmd_id 3
  api.client.on("push", (frame: BaichuanFrame) => {
    pushEventCount++;
    
    // Frame video: cmd_id 3, body binario, dimensione significativa
    if (frame.header.cmdId === 3 && frame.body.length > 100) {
      const isBinary = !frame.body.toString("utf8", 0, Math.min(10, frame.body.length)).startsWith("<?xml");
      if (isBinary) {
        videoFrames.push(frame);
        log(`🎥 Frame video ricevuto!`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
        });
      }
    }
    
    // Log primi 20 push events per debug
    if (pushEventCount <= 20) {
      const bodyPreview = frame.body.toString("utf8", 0, Math.min(50, frame.body.length));
      const isXml = bodyPreview.startsWith("<?xml") || bodyPreview.startsWith("<");
      if (pushEventCount <= 10 || frame.header.cmdId === 3) {
        log(`📨 Push #${pushEventCount}`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
          isXml,
        });
      }
    }
  });

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Test con cmd_id 3 (MSG_ID_VIDEO) - varianti di parametri
    // Basato su neolink stream.rs: BcXml serializza come <body> con Preview dentro
    // Prova con e senza extension XML (response_code 421 suggerisce che extension potrebbe servire)
    const testCases = [
      {
        name: "Sub stream - con extension XML (response_code 421)",
        handle: 256,
        streamType: 1,
        streamName: "subStream",
        useExtension: true,
      },
      {
        name: "Sub stream - senza extension XML",
        handle: 256,
        streamType: 1,
        streamName: "subStream",
        useExtension: false,
      },
      {
        name: "Main stream - con extension XML",
        handle: 0,
        streamType: 0,
        streamName: "mainStream",
        useExtension: true,
      },
    ];

    for (const testCase of testCases) {
      log(`\n🔍 Test: ${testCase.name}`);
      
      // Basato su neolink: BcXml serializza come <body> con Preview dentro
      // Preview ha version come attributo (@version in serde)
      const payloadXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${testCase.handle}</handle>
<streamType>${testCase.streamName}</streamType>
</Preview>
</body>`;

      try {
        const initialPushCount = pushEventCount;
        const initialVideoFrames = videoFrames.length;

        const frame = await api.client.sendFrame({
          cmdId: 3, // MSG_ID_VIDEO
          channel,
          payloadXml,
          extensionXml: testCase.useExtension ? buildChannelExtensionXml(channelId) : undefined,
          messageClass: 0x6414, // BC_CLASS_MODERN_24
          streamType: testCase.streamType,
        });

        log(`Risposta`, {
          responseCode: frame.header.responseCode,
          success: frame.header.responseCode === 200,
          note: frame.header.responseCode === 200 ? "✅ SUCCESS!" : frame.header.responseCode === 421 ? "⚠️  421 (diverso da 400)" : `❌ ${frame.header.responseCode}`,
        });

        if (frame.header.responseCode === 200 || frame.header.responseCode === 421) {
          // Anche se response_code è 421, potrebbe essere che lo stream sia comunque attivo
          // (421 potrebbe significare "Misdirected Request" ma lo stream potrebbe funzionare)
          logSuccess(`✅ Comando inviato (response_code ${frame.header.responseCode})! Attendo frame video...`);
          
          // Dopo aver inviato il comando Preview, potrebbe essere necessario sottoscriversi esplicitamente
          // ai frame video, come neolink fa alla linea 173 di stream.rs
          // Prova a sottoscriversi ai frame video con cmd_id 3 (MSG_ID_VIDEO)
          // Nota: Questo è un tentativo - potrebbe servire un cmd_id diverso o un formato diverso
          log(`🔍 Tentativo sottoscrizione esplicita ai frame video...`);
          
          try {
            // Prova a sottoscriversi ai frame video (simile a subscribeEvents ma per video)
            // Potrebbe essere necessario inviare un comando con cmd_id 3 senza payload, o con un payload diverso
            const subscribeFrame = await api.client.sendFrame({
              cmdId: 3, // MSG_ID_VIDEO - potrebbe servire per sottoscriversi
              channel,
              payloadXml: "", // Prova senza payload
              extensionXml: buildChannelExtensionXml(channelId),
              messageClass: 0x6414,
              streamType: testCase.streamType,
            });
            
            log(`Risposta sottoscrizione`, {
              responseCode: subscribeFrame.header.responseCode,
              note: subscribeFrame.header.responseCode === 200 ? "✅ Sottoscrizione accettata!" : `⚠️  ${subscribeFrame.header.responseCode}`,
            });
          } catch (error) {
            log(`⚠️  Errore durante sottoscrizione: ${error instanceof Error ? error.message : String(error)}`);
          }
          
          // Attendi 20 secondi per vedere se arrivano frame video
          await new Promise((resolve) => setTimeout(resolve, 20000));
          
          const newPushCount = pushEventCount - initialPushCount;
          const newVideoFrames = videoFrames.length - initialVideoFrames;
          
          log(`Risultato`, {
            pushEvents: newPushCount,
            videoFrames: newVideoFrames,
            success: newVideoFrames > 0,
          });
          
          if (newVideoFrames > 0) {
            logSuccess(`✅ TROVATI ${newVideoFrames} frame video!`);
            
            // Analizza il primo frame video
            const videoFrame = videoFrames[videoFrames.length - newVideoFrames];
            if (videoFrame) {
              try {
                const decrypted = api.client.tryDecryptBinary(
                  videoFrame.body,
                  videoFrame.header.channelId,
                  api.client.enc
                );
                
                // Cerca pattern NAL unit
                const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
                const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
                
                if (nalStart1 !== -1 || nalStart2 !== -1) {
                  logSuccess(`✅ Frame contiene NAL units H.264/H.265!`);
                  const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
                  if (nalPos < decrypted.length) {
                    const nalType = decrypted[nalPos]! & 0x1F;
                    log(`NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : nalType === 7 ? "SPS" : nalType === 8 ? "PPS" : "Other"})`);
                  }
                } else {
                  log(`⚠️  Nessun pattern NAL unit trovato`);
                  log(`   Primi 128 bytes (hex): ${decrypted.subarray(0, Math.min(128, decrypted.length)).toString("hex")}`);
                }
              } catch (error) {
                logError(`Errore durante analisi frame`, error);
              }
            }
            
            // Trovato! Esci
            break;
          } else {
            log(`⚠️  Nessun frame video ricevuto dopo 20 secondi`);
          }
        } else {
          log(`⚠️  Comando rifiutato, response_code: ${frame.header.responseCode}`);
        }
        
        // Pausa tra i test
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (error) {
        logError(`Errore durante test`, error);
      }
    }

    // Riepilogo
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    RIEPILOGO TEST                         ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\n📊 Push events totali ricevuti: ${pushEventCount}`);
    console.log(`📊 Frame video identificati: ${videoFrames.length}`);
    
    if (videoFrames.length > 0) {
      logSuccess(`✅ Trovati ${videoFrames.length} frame video!`);
    } else {
      console.log(`\n⚠️  Nessun frame video identificato.`);
      console.log(`   Response code 421 con extension XML suggerisce che siamo vicini,`);
      console.log(`   ma potrebbe servire un formato diverso o parametri aggiuntivi.`);
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

testVideoStreamSimple().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


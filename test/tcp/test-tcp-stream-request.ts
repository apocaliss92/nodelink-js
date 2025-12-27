#!/usr/bin/env node
/**
 * Test per identificare il cmd_id corretto per richiedere lo stream video
 * Prova vari cmd_id comuni e analizza le risposte
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index.js";
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

interface StreamRequestTest {
  cmdId: number;
  payloadXml: string;
  description: string;
}

async function testStreamRequests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST RICHIESTA STREAM VIDEO (TCP)                      ║");
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
  const profile = "sub"; // Test con sub stream (più leggero)

  // Vari cmd_id da testare basati su pattern comuni
  const tests: StreamRequestTest[] = [
    {
      cmdId: 56, // GetEnc - già usato per metadata
      payloadXml: `<body><subStream><enable>1</enable></subStream></body>`,
      description: "cmd_id 56 (GetEnc) con enable subStream",
    },
    {
      cmdId: 57, // SetEnc - già usato per set encoding
      payloadXml: `<body><subStream><enable>1</enable></subStream></body>`,
      description: "cmd_id 57 (SetEnc) con enable subStream",
    },
    {
      cmdId: 58, // Possibile cmd_id per streaming
      payloadXml: `<body><subStream><enable>1</enable></subStream></body>`,
      description: "cmd_id 58 con enable subStream",
    },
    {
      cmdId: 59, // Possibile cmd_id per streaming
      payloadXml: `<body><subStream><enable>1</enable></subStream></body>`,
      description: "cmd_id 59 con enable subStream",
    },
    {
      cmdId: 57,
      payloadXml: `<body><subStream><streamType>0</streamType></subStream></body>`,
      description: "cmd_id 57 con streamType",
    },
    {
      cmdId: 57,
      payloadXml: `<body><subStream><start>1</start></subStream></body>`,
      description: "cmd_id 57 con start subStream",
    },
  ];

  const videoFrames: BaichuanFrame[] = [];
  let pushEventCount = 0;

  try {
    // Registra handler PRIMA del login per catturare frame automatici
    api.client.on("push", (frame: BaichuanFrame) => {
      pushEventCount++;
      
      // Identifica possibili frame video
      const isBinary = !frame.body.toString("utf8", 0, Math.min(10, frame.body.length)).startsWith("<?xml");
      const isLarge = frame.body.length > 100;
      const isStreamType0 = frame.header.streamType === 0;
      
      if (isBinary && isLarge && isStreamType0) {
        videoFrames.push(frame);
        log(`🎥 Frame video ricevuto!`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
        });
      }
    });

    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Attendi un po' per vedere se arrivano frame automaticamente dopo login
    log("Attendo 5 secondi per vedere se arrivano frame automaticamente dopo login...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    
    log(`Frame ricevuti durante attesa: ${pushEventCount} push events, ${videoFrames.length} possibili frame video`);

    // Analizza i frame ricevuti automaticamente
    if (videoFrames.length > 0) {
      log(`Trovati ${videoFrames.length} frame automatici dopo login`);
      for (const frame of videoFrames) {
        try {
          const decrypted = api.client.tryDecryptBinary(
            frame.body,
            frame.header.channelId,
            api.client.enc
          );
          
          log(`Analisi frame automatico cmd_id ${frame.header.cmdId}`, {
            originalLen: frame.body.length,
            decryptedLen: decrypted.length,
            firstBytes: decrypted.subarray(0, Math.min(32, decrypted.length)).toString("hex"),
          });
          
          // Cerca pattern NAL unit
          const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
          const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
          
          if (nalStart1 !== -1 || nalStart2 !== -1) {
            logSuccess(`✅ Frame cmd_id ${frame.header.cmdId} contiene NAL units H.264/H.265!`);
            const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
            if (nalPos < decrypted.length) {
              const nalType = decrypted[nalPos]! & 0x1F;
              log(`NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : nalType === 7 ? "SPS" : nalType === 8 ? "PPS" : "Other"})`);
            }
          } else {
            // Controlla se è XML (non video)
            const isXml = decrypted.toString("utf8", 0, Math.min(10, decrypted.length)).startsWith("<?xml");
            if (isXml) {
              log(`⚠️  Frame cmd_id ${frame.header.cmdId} è XML, non video`);
            } else {
              log(`⚠️  Frame cmd_id ${frame.header.cmdId} non contiene pattern NAL unit (potrebbe essere incapsulato)`);
            }
          }
        } catch (error) {
          logError(`Errore durante analisi frame cmd_id ${frame.header.cmdId}`, error);
        }
      }
    }

    // Handler già registrato sopra

    // Test ogni cmd_id
    for (const test of tests) {
      log(`Test: ${test.description}`);
      
      try {
        const startTime = Date.now();
        const initialPushCount = pushEventCount;
        const initialVideoFrames = videoFrames.length;

        // Invia comando
        await api.sendXml({
          cmdId: test.cmdId,
          channel,
          payloadXml: test.payloadXml,
        });

        // Attendi 3 secondi per vedere se arrivano frame video
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const elapsed = Date.now() - startTime;
        const newPushCount = pushEventCount - initialPushCount;
        const newVideoFrames = videoFrames.length - initialVideoFrames;

        log(`Risultato test`, {
          cmdId: test.cmdId,
          elapsed: `${elapsed}ms`,
          pushEvents: newPushCount,
          videoFrames: newVideoFrames,
          success: newVideoFrames > 0,
        });

        if (newVideoFrames > 0) {
          logSuccess(`✅ TROVATO! cmd_id ${test.cmdId} ha generato ${newVideoFrames} frame video!`);
          
          // Analizza tutti i nuovi frame video
          for (let i = videoFrames.length - newVideoFrames; i < videoFrames.length; i++) {
            const frame = videoFrames[i];
            if (!frame) continue;
            
            try {
              const decrypted = api.client.tryDecryptBinary(
                frame.body,
                frame.header.channelId,
                api.client.enc
              );
              
              log(`Analisi frame cmd_id ${frame.header.cmdId}`, {
                originalLen: frame.body.length,
                decryptedLen: decrypted.length,
                firstBytes: decrypted.subarray(0, Math.min(32, decrypted.length)).toString("hex"),
              });
              
              // Cerca pattern NAL unit
              const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
              const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
              
              if (nalStart1 !== -1 || nalStart2 !== -1) {
                logSuccess(`✅ Frame cmd_id ${frame.header.cmdId} contiene NAL units H.264/H.265!`);
                const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
                if (nalPos < decrypted.length) {
                  const nalType = decrypted[nalPos]! & 0x1F;
                  log(`NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : "Other"})`);
                }
              } else {
                // Controlla se è XML (non video)
                const isXml = decrypted.toString("utf8", 0, Math.min(10, decrypted.length)).startsWith("<?xml");
                if (isXml) {
                  log(`⚠️  Frame cmd_id ${frame.header.cmdId} è XML, non video`);
                } else {
                  log(`⚠️  Frame cmd_id ${frame.header.cmdId} non contiene pattern NAL unit (potrebbe essere incapsulato)`);
                }
              }
            } catch (error) {
              logError(`Errore durante analisi frame cmd_id ${frame.header.cmdId}`, error);
            }
          }
        }
      } catch (error) {
        logError(`Errore durante test cmd_id ${test.cmdId}`, error);
      }

      // Pausa tra i test
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
      console.log(`\n🎯 cmd_id che hanno generato frame video:`);
      const cmdIds = new Set(videoFrames.map((f) => f.header.cmdId));
      for (const cmdId of cmdIds) {
        const count = videoFrames.filter((f) => f.header.cmdId === cmdId).length;
        console.log(`   - cmd_id ${cmdId}: ${count} frame`);
      }
    } else {
      console.log(`\n⚠️  Nessun frame video identificato.`);
      console.log(`   Possibili cause:`);
      console.log(`   - Il cmd_id corretto non è stato testato`);
      console.log(`   - Lo stream video richiede parametri diversi`);
      console.log(`   - Lo stream video arriva automaticamente senza comando esplicito`);
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
testStreamRequests().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


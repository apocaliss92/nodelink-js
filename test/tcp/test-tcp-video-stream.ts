#!/usr/bin/env node
/**
 * Test per lo streaming video via Baichuan
 * Testa startVideoStream e stopVideoStream con vari cmd_id per trovare quello corretto
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

async function testVideoStream() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST STREAM VIDEO BAICHUAN (TCP)                      ║");
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
  const profile: "main" | "sub" | "ext" = "sub"; // Test con sub stream (più leggero)

  // Valori cmd_id da testare - i valori corretti da neolink model.rs sono 3 e 4
  // Focus su cmd_id 3 (MSG_ID_VIDEO) che è il valore corretto
  const cmdIdCandidates = [3]; // Solo cmd_id 3 per ora, concentriamoci su quello

  const videoFrames: BaichuanFrame[] = [];
  let pushEventCount = 0;

  try {
    // Registra handler PRIMA del login per catturare tutti i push events
    api.client.on("push", (frame: BaichuanFrame) => {
      pushEventCount++;
      
      // Log tutti i push events per debug (solo i primi 10 per non intasare)
      if (pushEventCount <= 10) {
        const bodyPreview = frame.body.toString("utf8", 0, Math.min(50, frame.body.length));
        const isXml = bodyPreview.startsWith("<?xml") || bodyPreview.startsWith("<");
        log(`📨 Push event #${pushEventCount}`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
          isXml,
          bodyPreview: isXml ? bodyPreview : frame.body.subarray(0, Math.min(32, frame.body.length)).toString("hex"),
        });
      }
      
      // Identifica possibili frame video
      // I frame video hanno cmd_id 3 (MSG_ID_VIDEO) e body binario (non XML)
      const isBinary = !frame.body.toString("utf8", 0, Math.min(10, frame.body.length)).startsWith("<?xml");
      const isLarge = frame.body.length > 100;
      const isStreamType0 = frame.header.streamType === 0 || frame.header.streamType === 1;
      const isVideoCmdId = frame.header.cmdId === 3; // MSG_ID_VIDEO
      
      // Frame video: cmd_id 3, body binario, dimensione significativa
      if (isVideoCmdId && isBinary && isLarge && isStreamType0) {
        videoFrames.push(frame);
        log(`🎥 Frame video ricevuto!`, {
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
        });
        
        // Analizza il frame per vedere se contiene NAL units
        try {
          const decrypted = api.client.tryDecryptBinary(
            frame.body,
            frame.header.channelId,
            api.client.enc
          );
          
          // Cerca pattern NAL unit
          const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
          const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));
          
          if (nalStart1 !== -1 || nalStart2 !== -1) {
            logSuccess(`✅ Frame cmd_id 3 contiene NAL units H.264/H.265!`);
            const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
            if (nalPos < decrypted.length) {
              const nalType = decrypted[nalPos]! & 0x1F;
              log(`NAL unit type: ${nalType} (${nalType === 1 ? "Non-IDR" : nalType === 5 ? "IDR" : nalType === 7 ? "SPS" : nalType === 8 ? "PPS" : "Other"})`);
            }
          } else {
            log(`⚠️  Frame cmd_id 3 non contiene pattern NAL unit visibili (potrebbe essere incapsulato)`);
            log(`   Primi 64 bytes (hex): ${decrypted.subarray(0, Math.min(64, decrypted.length)).toString("hex")}`);
          }
        } catch (error) {
          logError(`Errore durante analisi frame video`, error);
        }
      }
    });

    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Test ogni cmd_id candidato
    for (const cmdId of cmdIdCandidates) {
      log(`Test cmd_id ${cmdId} per startVideoStream`);
      
      try {
        // Aggiorna temporaneamente il valore in constants
        // Per ora testiamo direttamente con sendXml usando il pattern di neolink
        const channelId = channel + 1;
        const profileStr = profile as "main" | "sub" | "ext";
        let handle: number;
        let streamType: number;
        let streamName: string;
        if (profileStr === "main") {
          handle = 0;
          streamType = 0;
          streamName = "mainStream";
        } else if (profileStr === "sub") {
          handle = 256;
          streamType = 1;
          streamName = "subStream";
        } else {
          handle = 1024;
          streamType = 0;
          streamName = "externStream";
        }
        
        // Prova diverse varianti del payload XML e extension
        // Neolink usa Bc::new_from_xml con BcMeta e BcXml, dove Preview è nel payload
        // Ma potrebbe servire anche un Extension XML con channelId
        const testVariants = [
          // Variante 1: senza <body> wrapper, senza extension
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>`,
            extensionXml: undefined,
            description: "Solo Preview, senza extension",
          },
          // Variante 2: con <body> wrapper, senza extension
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>
</body>`,
            extensionXml: undefined,
            description: "Preview con <body>, senza extension",
          },
          // Variante 3: senza <body> wrapper, con extension (response_code 421 - diverso da 400!)
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>`,
            extensionXml: `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>${channelId}</channelId></Extension>`,
            description: "Preview con extension XML (response_code 421)",
          },
          // Variante 5: con <body> wrapper, con extension
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>
</body>`,
            extensionXml: `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>${channelId}</channelId></Extension>`,
            description: "Preview con <body> e extension XML",
          },
          // Variante 6: Preview senza channelId nel payload (solo in extension)
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<Preview version="1.0">
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>`,
            extensionXml: `<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"><channelId>${channelId}</channelId></Extension>`,
            description: "Preview senza channelId (solo in extension)",
          },
          // Variante 4: senza version in Preview
          {
            payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<Preview>
<channelId>${channelId}</channelId>
<handle>${handle}</handle>
<streamType>${streamName}</streamType>
</Preview>`,
            extensionXml: undefined,
            description: "Preview senza version",
          },
        ];

        const startTime = Date.now();
        let commandAccepted = false;

        // Testa ogni variante
        for (let variantIndex = 0; variantIndex < testVariants.length; variantIndex++) {
          const variant = testVariants[variantIndex]!;
          
          log(`Test cmd_id ${cmdId}, variante ${variantIndex + 1}/${testVariants.length}: ${variant.description}`);
          
          try {
            const frame = await api.client.sendFrame({
              cmdId,
              channel,
              payloadXml: variant.payloadXml,
              extensionXml: variant.extensionXml,
              messageClass: 0x6414, // BC_CLASS_MODERN_24
              streamType,
            });

            log(`Risposta cmd_id ${cmdId} (variante ${variantIndex + 1})`, {
              responseCode: frame.header.responseCode,
              cmdId: frame.header.cmdId,
              streamType: frame.header.streamType,
              channelId: frame.header.channelId,
              bodyLen: frame.body.length,
              success: frame.header.responseCode === 200,
              note: frame.header.responseCode === 200 ? "✅ Comando accettato!" : `⚠️  Rifiutato (response_code ${frame.header.responseCode})`,
            });

            if (frame.header.responseCode === 200) {
              logSuccess(`✅ TROVATO! Variante ${variantIndex + 1} funziona con cmd_id ${cmdId}!`);
              commandAccepted = true;
              break; // Esce dal loop delle varianti
            } else if (frame.header.responseCode !== 400 && frame.header.responseCode !== 421) {
              // Se il response_code è diverso da 400/421, potrebbe essere un progresso
              log(`⚠️  Response code ${frame.header.responseCode} (diverso da 400/421) - potrebbe essere un progresso`);
            }
          } catch (error) {
            logError(`Errore variante ${variantIndex + 1}`, error);
          }
        }
        
        if (!commandAccepted) {
          // Se nessuna variante ha funzionato, continua con il prossimo cmd_id
          log(`⚠️  Nessuna variante ha funzionato per cmd_id ${cmdId}`);
          continue;
        }

        // Se il comando è stato accettato, attendi i frame video
        const initialPushCount = pushEventCount;
        const initialVideoFrames = videoFrames.length;

        logSuccess(`✅ Comando cmd_id ${cmdId} accettato! Attendo frame video...`);
        
        // Attendi 15 secondi per vedere se arrivano frame video (più tempo per lo stream)
        await new Promise((resolve) => setTimeout(resolve, 15000));

        const elapsed = Date.now() - startTime;
        const newPushCount = pushEventCount - initialPushCount;
        const newVideoFrames = videoFrames.length - initialVideoFrames;

        log(`Risultato test cmd_id ${cmdId}`, {
          elapsed: `${elapsed}ms`,
          pushEvents: newPushCount,
          videoFrames: newVideoFrames,
          success: newVideoFrames > 0,
        });

        if (newVideoFrames > 0) {
          logSuccess(`✅ TROVATO! cmd_id ${cmdId} ha generato ${newVideoFrames} frame video!`);
          
          // Analizza i frame video
          for (let i = videoFrames.length - newVideoFrames; i < videoFrames.length; i++) {
            const frame = videoFrames[i];
            if (!frame) continue;
            
            try {
              const decrypted = api.client.tryDecryptBinary(
                frame.body,
                frame.header.channelId,
                api.client.enc
              );
              
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
                break; // Trovato, esci dal loop
              }
            } catch (error) {
              // Ignora errori di decriptazione
            }
          }
          
          // Se abbiamo trovato frame video validi, questo è il cmd_id corretto!
          console.log(`\n🎯 cmd_id ${cmdId} è CORRETTO per lo streaming video!`);
          console.log(`   Aggiorna BC_CMD_ID_VIDEO in src/protocol/constants.ts con questo valore.\n`);
          break; // Trovato, esci dal loop dei cmd_id
        }

        // Pausa tra i test
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        logError(`Errore durante test cmd_id ${cmdId}`, error);
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
      const cmdIds = new Set(videoFrames.map((f) => f.header.cmdId));
      console.log(`\n🎯 cmd_id che hanno generato frame video:`);
      for (const cmdId of cmdIds) {
        const count = videoFrames.filter((f) => f.header.cmdId === cmdId).length;
        console.log(`   - cmd_id ${cmdId}: ${count} frame`);
      }
    } else {
      console.log(`\n⚠️  Nessun frame video identificato.`);
      console.log(`   Possibili cause:`);
      console.log(`   - I cmd_id testati non sono corretti`);
      console.log(`   - Lo stream video richiede parametri diversi`);
      console.log(`   - Verifica i valori in neolink crates/core/src/bc/model.rs`);
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
testVideoStream().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


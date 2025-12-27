#!/usr/bin/env node
/**
 * Test dettagliato per identificare i frame video Baichuan
 * Analizza tutti i push events dopo aver inviato il comando Preview
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

interface FrameAnalysis {
  cmdId: number;
  streamType: number;
  channelId: number;
  bodyLen: number;
  isXml: boolean;
  isBinary: boolean;
  firstBytes: string;
  decryptedPreview?: string;
  hasNalUnits?: boolean;
  nalUnitTypes?: number[];
}

async function testVideoStreamDetailed() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST DETTAGLIATO STREAM VIDEO BAICHUAN                ║");
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

  const allFrames: BaichuanFrame[] = [];
  const frameAnalysis = new Map<string, FrameAnalysis>();
  let pushEventCount = 0;

  // Handler per TUTTI i push events - analizza tutto
  api.client.on("push", (frame: BaichuanFrame) => {
    pushEventCount++;
    allFrames.push(frame);

    const key = `${frame.header.cmdId}:${frame.header.streamType}:${frame.header.channelId}`;
    
    const bodyPreview = frame.body.toString("utf8", 0, Math.min(50, frame.body.length));
    const isXml = bodyPreview.startsWith("<?xml") || bodyPreview.startsWith("<");
    const isBinary = !isXml && frame.body.length > 0;

    if (!frameAnalysis.has(key)) {
      frameAnalysis.set(key, {
        cmdId: frame.header.cmdId,
        streamType: frame.header.streamType,
        channelId: frame.header.channelId,
        bodyLen: frame.body.length,
        isXml,
        isBinary,
        firstBytes: frame.body.subarray(0, Math.min(32, frame.body.length)).toString("hex"),
      });
    }

    // Analizza TUTTI i frame binari (non solo quelli grandi) - potrebbero essere frame video
    if (isBinary && frame.body.length > 0) {
      try {
        const decrypted = api.client.tryDecryptBinary(
          frame.body,
          frame.header.channelId,
          api.client.enc
        );

        const analysis = frameAnalysis.get(key)!;
        
        // Per frame con cmdId=3, mostra più dettagli
        if (frame.header.cmdId === 3 && frame.body.length > 100) {
          // Mostra i primi 512 bytes per capire la struttura
          analysis.decryptedPreview = decrypted.subarray(0, Math.min(512, decrypted.length)).toString("hex");
          
          // Mostra anche come stringa per vedere se c'è XML
          const asString = decrypted.toString("utf8", 0, Math.min(200, decrypted.length));
          if (asString.includes("<?xml") || asString.includes("<Extension")) {
            // C'è XML - trova dove finisce
            const xmlEnd = decrypted.indexOf(Buffer.from("</Extension>"));
            if (xmlEnd === -1) {
              const bodyEnd = decrypted.indexOf(Buffer.from("</body>"));
              if (bodyEnd !== -1) {
                // Mostra i primi bytes dopo </body>
                const afterBody = decrypted.subarray(bodyEnd + 7, Math.min(bodyEnd + 100, decrypted.length));
                analysis.decryptedPreview = `XML fino a </body>, poi: ${afterBody.toString("hex").substring(0, 128)}`;
              }
            } else {
              // Mostra i primi bytes dopo </Extension>
              const afterExt = decrypted.subarray(xmlEnd + 13, Math.min(xmlEnd + 100, decrypted.length));
              analysis.decryptedPreview = `XML fino a </Extension>, poi: ${afterExt.toString("hex").substring(0, 128)}`;
            }
          }
        } else {
          analysis.decryptedPreview = decrypted.subarray(0, Math.min(256, decrypted.length)).toString("hex");
        }

        // Cerca pattern NAL unit (H.264/H.265)
        const nalStart1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
        const nalStart2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]));

        if (nalStart1 !== -1 || nalStart2 !== -1) {
          analysis.hasNalUnits = true;

          // Analizza NAL unit types
          const nalTypes: number[] = [];
          let searchPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
          while (searchPos < decrypted.length && nalTypes.length < 5) {
            const nalType = decrypted[searchPos]! & 0x1F;
            nalTypes.push(nalType);
            // Cerca prossimo NAL unit
            const nextNal1 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]), searchPos + 1);
            const nextNal2 = decrypted.indexOf(Buffer.from([0x00, 0x00, 0x01]), searchPos + 1);
            if (nextNal1 !== -1 || nextNal2 !== -1) {
              searchPos = nextNal1 !== -1 ? nextNal1 + 4 : nextNal2 + 3;
            } else {
              break;
            }
          }
          analysis.nalUnitTypes = nalTypes;
        } else {
          // I frame video Baichuan potrebbero avere Extension XML prima dei dati video
          // Cerca NAL units dopo l'XML Extension o body
          let searchStart = 0;
          const extensionEnd = decrypted.indexOf(Buffer.from("</Extension>"));
          const bodyEnd = decrypted.indexOf(Buffer.from("</body>"));
          
          if (extensionEnd !== -1) {
            // C'è Extension XML - cerca NAL units dopo
            searchStart = extensionEnd + Buffer.from("</Extension>").length;
          } else if (bodyEnd !== -1) {
            // C'è body XML - cerca NAL units dopo
            searchStart = bodyEnd + Buffer.from("</body>").length;
          }
          
          if (searchStart > 0 && searchStart < decrypted.length) {
            const afterXml = decrypted.subarray(searchStart);
            const nalStart1 = afterXml.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
            const nalStart2 = afterXml.indexOf(Buffer.from([0x00, 0x00, 0x01]));
            
            if (nalStart1 !== -1 || nalStart2 !== -1) {
              analysis.hasNalUnits = true;
              const nalPos = nalStart1 !== -1 ? nalStart1 + 4 : nalStart2 + 3;
              const videoData = afterXml.subarray(nalStart1 !== -1 ? nalStart1 : nalStart2);
              analysis.decryptedPreview = videoData.subarray(0, Math.min(256, videoData.length)).toString("hex");
              
              // Analizza NAL unit types
              const nalTypes: number[] = [];
              let searchPos = nalPos;
              while (searchPos < afterXml.length && nalTypes.length < 5) {
                const nalType = afterXml[searchPos]! & 0x1F;
                nalTypes.push(nalType);
                // Cerca prossimo NAL unit
                const nextNal1 = afterXml.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]), searchPos + 1);
                const nextNal2 = afterXml.indexOf(Buffer.from([0x00, 0x00, 0x01]), searchPos + 1);
                if (nextNal1 !== -1 || nextNal2 !== -1) {
                  searchPos = nextNal1 !== -1 ? nextNal1 + 4 : nextNal2 + 3;
                } else {
                  break;
                }
              }
              analysis.nalUnitTypes = nalTypes;
            } else {
              // Nessun NAL unit trovato dopo XML - mostra i primi bytes dopo XML per debug
              analysis.decryptedPreview = afterXml.subarray(0, Math.min(512, afterXml.length)).toString("hex");
            }
          }
          
          // Anche se non ci sono NAL units visibili, potrebbe essere un frame video incapsulato
          // Cerca pattern comuni nei frame video (magic bytes, header patterns, etc.)
          const startsWithZeros = decrypted[0] === 0x00 && decrypted[1] === 0x00;
          if (startsWithZeros && decrypted.length > 10) {
            // Potrebbe essere un frame video con header personalizzato
            analysis.decryptedPreview = decrypted.subarray(0, Math.min(512, decrypted.length)).toString("hex");
          }
        }
      } catch (error) {
        // Ignora errori di decriptazione
      }
    }
  });

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Invia comando Preview (sub stream)
    // Nota: Neolink fa connection.subscribe(MSG_ID_VIDEO, msg_num) PRIMA di inviare il comando
    // Questo crea un canale dedicato. Nel nostro caso, i frame arrivano come push events.
    log("Invio comando Preview per sub stream");
    
    // Testa diverse varianti del formato XML
    // Variante 1: Preview con channelId + extension XML (response_code 421)
    const payloadXml1 = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<channelId>${channelId}</channelId>
<handle>256</handle>
<streamType>subStream</streamType>
</Preview>
</body>`;

    // Variante 2: Preview senza channelId (solo in extension) + extension XML
    const payloadXml2 = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview version="1.0">
<handle>256</handle>
<streamType>subStream</streamType>
</Preview>
</body>`;

    // Variante 3: Preview senza version attribute
    const payloadXml3 = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Preview>
<channelId>${channelId}</channelId>
<handle>256</handle>
<streamType>subStream</streamType>
</Preview>
</body>`;

    // Neolink NON usa Extension XML per il comando Preview
    // Testa varianti senza extension XML (come neolink)
    const variants = [
      { name: "Preview con channelId SENZA extension (come neolink)", payload: payloadXml1, extension: undefined },
      { name: "Preview senza channelId SENZA extension", payload: payloadXml2, extension: undefined },
      { name: "Preview senza version SENZA extension", payload: payloadXml3, extension: undefined },
      // Testa anche con extension per confronto
      { name: "Preview con channelId + extension (per confronto)", payload: payloadXml1, extension: buildChannelExtensionXml(channelId) },
    ];

    let bestFrame: { frame: any; variant: string } | undefined;

    for (const variant of variants) {
      log(`Test variante: ${variant.name}`);
      
      try {
        const frame = await api.client.sendFrame({
          cmdId: 3, // MSG_ID_VIDEO
          channel,
          payloadXml: variant.payload,
          extensionXml: variant.extension,
          messageClass: 0x6414, // BC_CLASS_MODERN_24
          streamType: 1, // sub stream
        });

        log(`Risposta variante "${variant.name}"`, {
          responseCode: frame.header.responseCode,
          cmdId: frame.header.cmdId,
          streamType: frame.header.streamType,
          channelId: frame.header.channelId,
          bodyLen: frame.body.length,
          note: frame.header.responseCode === 200 ? "✅ SUCCESS!" : frame.header.responseCode === 421 ? "⚠️  421" : `❌ ${frame.header.responseCode}`,
        });

        if (frame.header.responseCode === 200) {
          logSuccess(`✅ TROVATO! Variante "${variant.name}" funziona con response_code 200!`);
          bestFrame = { frame, variant: variant.name };
          break; // Trovato, esci
        } else if (frame.header.responseCode === 421 && !bestFrame) {
          // 421 è meglio di 400, ma non ideale
          bestFrame = { frame, variant: variant.name };
        }

        // Pausa tra i test
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        logError(`Errore variante "${variant.name}"`, error);
      }
    }

    if (!bestFrame) {
      logError("Nessuna variante ha funzionato", new Error("All variants failed"));
      return;
    }

    log(`Migliore variante: "${bestFrame.variant}" con response_code ${bestFrame.frame.header.responseCode}`);
    
    // Anche con response_code 421, potrebbe funzionare - continuiamo ad ascoltare

    // Attendi 30 secondi per raccogliere tutti i frame
    logSuccess("Attendo 30 secondi per raccogliere frame video...");
    log("⚠️  Assicurati che ci sia attività video sulla camera (movimento, etc.)");
    log("⚠️  Analizzerò TUTTI i frame ricevuti, non solo quelli con cmd_id 3");
    
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // Analisi risultati
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    ANALISI FRAME                            ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\n📊 Push events totali ricevuti: ${pushEventCount}`);
    console.log(`📊 Tipi di frame unici: ${frameAnalysis.size}\n`);

    // Ordina per frequenza
    const frameCounts = new Map<string, number>();
    for (const f of allFrames) {
      const key = `${f.header.cmdId}:${f.header.streamType}:${f.header.channelId}`;
      frameCounts.set(key, (frameCounts.get(key) || 0) + 1);
    }

    const sortedFrames = Array.from(frameAnalysis.entries()).sort((a, b) => {
      const countA = frameCounts.get(a[0]) || 0;
      const countB = frameCounts.get(b[0]) || 0;
      return countB - countA;
    });

    for (const [key, analysis] of sortedFrames) {
      const count = frameCounts.get(key) || 0;
      const percentage = ((count / pushEventCount) * 100).toFixed(2);

      log(`Frame Type: cmdId=${analysis.cmdId}, streamType=${analysis.streamType}, channelId=${analysis.channelId}`, {
        count,
        percentage: `${percentage}%`,
        bodyLen: analysis.bodyLen,
        type: analysis.isXml ? "XML" : analysis.isBinary ? "Binary" : "Unknown",
        firstBytes: analysis.firstBytes,
        hasNalUnits: analysis.hasNalUnits,
        nalUnitTypes: analysis.nalUnitTypes,
        decryptedPreview: analysis.decryptedPreview ? `${analysis.decryptedPreview.substring(0, 128)}...` : undefined,
      });

      if (analysis.hasNalUnits) {
        logSuccess(`✅ TROVATO! Frame video con NAL units!`);
        log(`   NAL unit types: ${analysis.nalUnitTypes?.map(t => {
          const names: Record<number, string> = {
            1: "Non-IDR",
            5: "IDR (I-frame)",
            6: "SEI",
            7: "SPS",
            8: "PPS",
          };
          return `${t} (${names[t] || "Other"})`;
        }).join(", ")}`);
        log(`   Decrypted preview (hex): ${analysis.decryptedPreview}`);
      }
    }

    // Identifica possibili frame video
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║           IDENTIFICAZIONE FRAME VIDEO                      ║");
    console.log("╚════════════════════════════════════════════════════════════╝");

    const videoFrames = sortedFrames.filter(([_, a]) => a.hasNalUnits);
    if (videoFrames.length > 0) {
      logSuccess(`Trovati ${videoFrames.length} tipi di frame video con NAL units!`);
      for (const [key, analysis] of videoFrames) {
        log(`Frame Video`, {
          cmdId: analysis.cmdId,
          streamType: analysis.streamType,
          channelId: analysis.channelId,
          count: frameCounts.get(key),
          nalUnitTypes: analysis.nalUnitTypes,
        });
      }
    } else {
      logError("Nessun frame video identificato con NAL units.", new Error("No video frames found"));
      console.log("\n💡 Suggerimenti:");
      console.log("   - I frame video potrebbero essere incapsulati in un formato diverso");
      console.log("   - Potrebbe servire un meccanismo di subscribe come in neolink");
      console.log("   - Verifica se i frame con cmd_id 3 contengono dati video");
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

testVideoStreamDetailed().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


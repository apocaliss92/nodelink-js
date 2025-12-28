#!/usr/bin/env node
/**
 * Test per verificare il parsing dei frame BcMedia
 * Analizza i frame ricevuti con cmd_id 3 e verifica se contengono BcMedia packets
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame, parseBcMedia } from "../../index.js";
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

async function testBcMediaParsing() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST PARSING BCMEDIA PACKETS                          ║");
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
  let frameCount = 0;
  let bcMediaCount = 0;
  const bcMediaTypes = new Map<string, number>();

  // Handler per frame con cmd_id 3
  api.client.on("push", (frame: BaichuanFrame) => {
    if (frame.header.cmdId !== 3) return;

    frameCount++;

    // Decrypt frame body
    const decrypted = api.client.tryDecryptBinary(
      frame.body,
      frame.header.channelId,
      api.client.enc
    );

    // Find where BcMedia packets start (after XML if present)
    let searchStart = 0;
    const extensionEnd = decrypted.indexOf(Buffer.from("</Extension>"));
    const bodyEnd = decrypted.indexOf(Buffer.from("</body>"));
    
    if (extensionEnd !== -1) {
      searchStart = extensionEnd + Buffer.from("</Extension>").length;
    } else if (bodyEnd !== -1) {
      searchStart = bodyEnd + Buffer.from("</body>").length;
    }

    // Parse BcMedia packets
    let offset = searchStart;
    let parsedInFrame = 0;
    
    while (offset < decrypted.length) {
      const remaining = decrypted.subarray(offset);
      const result = parseBcMedia(remaining);
      
      if (!result) {
        break;
      }

      const { media, consumed } = result;
      bcMediaCount++;
      parsedInFrame++;
      
      const typeKey = media.type;
      bcMediaTypes.set(typeKey, (bcMediaTypes.get(typeKey) || 0) + 1);

      // Log primi 5 BcMedia packets per debug
      if (bcMediaCount <= 5) {
        if (media.type === "Iframe" || media.type === "Pframe") {
          log(`BcMedia #${bcMediaCount} - ${media.type}`, {
            videoType: media.videoType,
            microseconds: media.microseconds,
            time: media.type === "Iframe" ? media.time : undefined,
            dataLen: media.data.length,
            dataPreview: media.data.subarray(0, Math.min(32, media.data.length)).toString("hex"),
          });
        } else {
          log(`BcMedia #${bcMediaCount} - ${media.type}`, {
            dataLen: media.data ? media.data.length : undefined,
          });
        }
      }

      offset += consumed;
    }

    // Log ogni 100 frame
    if (frameCount % 100 === 0) {
      log(`Frame processati: ${frameCount}, BcMedia packets: ${bcMediaCount}`);
    }
  });

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Start video stream
    log("Avvio stream video (sub stream)");
    await api.startVideoStream(channel, "sub");
    logSuccess("Stream video avviato (response_code 200)");

    // Attendi 30 secondi per raccogliere frame
    logSuccess("Attendo 30 secondi per raccogliere e parsare frame BcMedia...");
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // Analisi risultati
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    RISULTATI                                ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\n📊 Frame ricevuti (cmd_id 3): ${frameCount}`);
    console.log(`📊 BcMedia packets parsati: ${bcMediaCount}`);
    console.log(`\n📊 Tipi di BcMedia packets:`);
    
    for (const [type, count] of Array.from(bcMediaTypes.entries()).sort((a, b) => b[1] - a[1])) {
      const percentage = ((count / bcMediaCount) * 100).toFixed(2);
      console.log(`   ${type}: ${count} (${percentage}%)`);
    }

    if (bcMediaCount > 0) {
      logSuccess(`✅ TROVATI ${bcMediaCount} BcMedia packets!`);
      logSuccess("✅ Il parser BcMedia funziona correttamente!");
      
      const videoFrames = (bcMediaTypes.get("Iframe") || 0) + (bcMediaTypes.get("Pframe") || 0);
      if (videoFrames > 0) {
        logSuccess(`✅ TROVATI ${videoFrames} frame video (Iframe + Pframe)!`);
      }
    } else {
      logError("Nessun BcMedia packet parsato", new Error("No BcMedia packets found"));
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

testBcMediaParsing().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


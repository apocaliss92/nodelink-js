#!/usr/bin/env node
/**
 * Test per caricare e parsare frame video salvati in locale
 * Non richiede connessione alla camera
 */

// @ts-expect-error - Path resolution at runtime
import { parseBcMedia, BcMediaCodec } from "../../index.js";
import * as fs from "node:fs";
import * as path from "node:path";

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

async function loadAndParseFrames() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST PARSING FRAME SALVATI IN LOCALE                  ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  const framesDir = path.join(process.cwd(), "test", "frames");
  
  if (!fs.existsSync(framesDir)) {
    logError("Directory frames non trovata", new Error(`Directory ${framesDir} non esiste. Esegui prima test-tcp-video-stream-save-frames.ts`));
    process.exit(1);
  }

  // Trova tutti i file frame_*.bin
  const frameFiles = fs.readdirSync(framesDir)
    .filter(f => f.startsWith("frame_") && f.endsWith(".bin"))
    .sort();

  if (frameFiles.length === 0) {
    logError("Nessun frame trovato", new Error(`Nessun file frame_*.bin trovato in ${framesDir}`));
    process.exit(1);
  }

  log(`Trovati ${frameFiles.length} frame da analizzare`);

  let totalBcMedia = 0;
  const bcMediaTypes = new Map<string, number>();
  const videoFrames: Array<{ frameFile: string; media: any }> = [];
  
  // Use BcMediaCodec to handle fragmented packets
  const codec = new BcMediaCodec(false);

  for (const frameFile of frameFiles) {
    const framePath = path.join(framesDir, frameFile);
    const frameData = fs.readFileSync(framePath);
    
    // Carica metadati se disponibili
    const metadataFile = frameFile.replace(".bin", ".json");
    const metadataPath = path.join(framesDir, metadataFile);
    let metadata: any = null;
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    }

    log(`Analizzando ${frameFile}`, {
      size: frameData.length,
      metadata: metadata ? {
        cmdId: metadata.cmdId,
        streamType: metadata.streamType,
        channelId: metadata.channelId,
      } : null,
    });

    // Prova anche a caricare il payload separato se esiste
    const payloadFile = frameFile.replace(".bin", "_payload.bin");
    let payloadData: Buffer | null = null;
    if (fs.existsSync(path.join(framesDir, payloadFile))) {
      payloadData = fs.readFileSync(path.join(framesDir, payloadFile));
      log(`Trovato payload separato: ${payloadFile} (${payloadData.length} bytes)`);
    }

    // Find where BcMedia packets start (after XML if present)
    let searchStart = 0;
    const extensionEnd = frameData.indexOf(Buffer.from("</Extension>"));
    const bodyEnd = frameData.indexOf(Buffer.from("</body>"));
    
    if (extensionEnd !== -1) {
      searchStart = extensionEnd + Buffer.from("</Extension>").length;
    } else if (bodyEnd !== -1) {
      searchStart = bodyEnd + Buffer.from("</body>").length;
    }

    // Use BcMediaCodec to handle fragmented packets
    // The codec buffers incomplete packets and assembles them when complete
    const dataToParse = payloadData || frameData.subarray(searchStart);
    const mediaPackets = codec.decode(dataToParse);
    
    let parsedInFrame = 0;
    for (const media of mediaPackets) {
      totalBcMedia++;
      parsedInFrame++;
      
      const typeKey = media.type;
      bcMediaTypes.set(typeKey, (bcMediaTypes.get(typeKey) || 0) + 1);

      // Salva frame video per analisi
      if (media.type === "Iframe" || media.type === "Pframe") {
        videoFrames.push({ frameFile, media });
        
        log(`BcMedia #${totalBcMedia} - ${media.type}`, {
          videoType: media.videoType,
          microseconds: media.microseconds,
          time: media.type === "Iframe" ? media.time : undefined,
          dataLen: media.data.length,
          dataPreview: media.data.subarray(0, Math.min(32, media.data.length)).toString("hex"),
        });
      }
    }

    if (parsedInFrame > 0) {
      logSuccess(`Parsati ${parsedInFrame} BcMedia packets da ${frameFile}`);
    } else {
      log(`Nessun BcMedia packet trovato in ${frameFile}`);
    }
  }

  // Risultati finali
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║                    RISULTATI                                ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\n📊 Frame analizzati: ${frameFiles.length}`);
  console.log(`📊 BcMedia packets parsati: ${totalBcMedia}`);
  console.log(`\n📊 Tipi di BcMedia packets:`);
  
  for (const [type, count] of Array.from(bcMediaTypes.entries()).sort((a, b) => b[1] - a[1])) {
    const percentage = totalBcMedia > 0 ? ((count / totalBcMedia) * 100).toFixed(2) : "0.00";
    console.log(`   ${type}: ${count} (${percentage}%)`);
  }

  if (totalBcMedia > 0) {
    logSuccess(`✅ TROVATI ${totalBcMedia} BcMedia packets!`);
    logSuccess("✅ Il parser BcMedia funziona correttamente!");
    
    const videoFramesCount = (bcMediaTypes.get("Iframe") || 0) + (bcMediaTypes.get("Pframe") || 0);
    if (videoFramesCount > 0) {
      logSuccess(`✅ TROVATI ${videoFramesCount} frame video (Iframe + Pframe)!`);
    }
  } else {
    logError("Nessun BcMedia packet parsato", new Error("No BcMedia packets found"));
  }
}

loadAndParseFrames().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


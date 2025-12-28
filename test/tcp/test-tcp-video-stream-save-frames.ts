#!/usr/bin/env node
/**
 * Test per salvare frame video in locale per testing successivo
 * Salva i frame decriptati con cmd_id 3 in file binari
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index.js";
import { config } from "../env.js";
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

async function saveFrames() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     SALVATAGGIO FRAME VIDEO IN LOCALE                      ║");
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
  const framesDir = path.join(process.cwd(), "test", "frames");
  
  // Crea directory se non esiste
  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  let frameCount = 0;
  const maxFrames = 50; // Salva più frame per trovare frame video completi

  // Handler per frame con cmd_id 3
  api.client.on("push", (frame: BaichuanFrame) => {
    if (frame.header.cmdId !== 3) return;
    if (frameCount >= maxFrames) return;

    // Per i frame video, extension e payload potrebbero essere criptati separatamente
    // Salva sia il body completo decriptato che extension e payload separati
    const decryptedBody = api.client.tryDecryptBinary(
      frame.body,
      frame.header.channelId,
      api.client.enc
    );
    
    // Decripta anche extension e payload separatamente (potrebbero essere criptati diversamente)
    const decryptedExtension = frame.extension.length > 0 
      ? api.client.tryDecryptBinary(frame.extension, frame.header.channelId, api.client.enc)
      : Buffer.alloc(0);
    const decryptedPayload = frame.payload.length > 0
      ? api.client.tryDecryptBinary(frame.payload, frame.header.channelId, api.client.enc)
      : Buffer.alloc(0);

    // Salva body completo decriptato
    const frameFile = path.join(framesDir, `frame_${frameCount.toString().padStart(3, "0")}.bin`);
    fs.writeFileSync(frameFile, decryptedBody);
    
    // Salva anche payload separato (potrebbe contenere i BcMedia packets)
    const payloadFile = path.join(framesDir, `frame_${frameCount.toString().padStart(3, "0")}_payload.bin`);
    fs.writeFileSync(payloadFile, decryptedPayload);
    
    // Salva anche metadati del frame
    const metadata = {
      frameIndex: frameCount,
      cmdId: frame.header.cmdId,
      streamType: frame.header.streamType,
      channelId: frame.header.channelId,
      msgNum: frame.header.msgNum,
      responseCode: frame.header.responseCode,
      bodyLen: frame.body.length,
      extensionLen: frame.extension.length,
      payloadLen: frame.payload.length,
      decryptedBodyLen: decryptedBody.length,
      decryptedExtensionLen: decryptedExtension.length,
      decryptedPayloadLen: decryptedPayload.length,
      timestamp: new Date().toISOString(),
    };
    const metadataFile = path.join(framesDir, `frame_${frameCount.toString().padStart(3, "0")}.json`);
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));

    frameCount++;
    
    if (frameCount % 5 === 0) {
      logSuccess(`Salvati ${frameCount} frame`);
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

    // Attendi fino a raccogliere maxFrames frame
    logSuccess(`Attendo fino a raccogliere ${maxFrames} frame...`);
    while (frameCount < maxFrames) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    logSuccess(`✅ Salvati ${frameCount} frame in ${framesDir}`);
    console.log(`\n📁 Frame salvati:`);
    for (let i = 0; i < frameCount; i++) {
      const idx = i.toString().padStart(3, "0");
      console.log(`   - frame_${idx}.bin (dati binari)`);
      console.log(`   - frame_${idx}.json (metadati)`);
    }

  } catch (error) {
    logError("Errore critico durante il salvataggio", error);
    if (error instanceof Error && error.stack) {
      console.error("\nStack trace completo:");
      console.error(error.stack);
    }
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

saveFrames().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});


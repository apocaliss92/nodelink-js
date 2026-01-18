#!/usr/bin/env node
/**
 * Test per verificare se possiamo inviare getBatteryInfo senza login.
 * 
 * Sequenza:
 * 1. Discovery UDP (senza login) per ottenere CID/DID
 * 2. Prova a inviare getBatteryInfo (cmd_id 253) senza login
 * 3. Verifica se la camera risponde e se si sveglia
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fmtNow(): string {
  return new Date().toISOString();
}

function log(message: string, data?: unknown) {
  console.log(`[${fmtNow()}] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function logSection(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

/**
 * Prova a inviare un comando Baichuan senza login
 */
async function sendCommandWithoutLogin(
  api: ReolinkBaichuanApi,
  cmdId: number,
  cmdName: string,
  timeoutMs: number = 5000
): Promise<{ success: boolean; responseTimeMs: number; error?: string; response?: any }> {
  logSection(`TEST: Invio ${cmdName} (cmd_id ${cmdId}) senza login`);
  
  const startTime = Date.now();
  let responseReceived = false;
  let responseData: any = undefined;
  let responseError: string | undefined = undefined;
  
  // Ascolta risposte
  const responseHandler = (frame: any) => {
    if (frame.header.cmdId === cmdId) {
      responseReceived = true;
      responseData = {
        cmdId: frame.header.cmdId,
        responseCode: frame.header.responseCode,
        bodyLength: frame.body.length,
        bodyPreview: frame.body.toString("utf8", 0, Math.min(200, frame.body.length)),
      };
      log(`✓ Risposta ricevuta:`, responseData);
    }
  };
  
  api.client.on("frame", responseHandler);
  
  try {
    // Accedi al socket UDP
    const udpStream = (api.client as any).udpSocket;
    if (!udpStream || !udpStream.isConnected()) {
      // Connetti senza login
      log(`Connessione UDP (discovery)...`);
      await (api.client as any).connectUdp();
      await sleep(2000); // Attendi discovery
      
      const isConnected = (api.client as any).udpSocket?.isConnected?.();
      if (!isConnected) {
        throw new Error("Impossibile connettersi via UDP");
      }
      log(`✓ Connesso via UDP (senza login)`);
    }
    
    // Ottieni CID/DID dal socket
    const cid = (api.client as any).udpSocket?.clientId;
    const did = (api.client as any).udpSocket?.cameraId;
    
    if (!cid || !did) {
      throw new Error("CID/DID non disponibili");
    }
    
    log(`CID: ${cid}, DID: ${did}`);
    log(`Invio comando ${cmdName} (cmd_id ${cmdId})...`);
    
    // Prova a inviare il comando usando l'API (che fallirà senza login)
    // Ma prima verifichiamo se possiamo accedere direttamente al socket
    try {
      // Usa l'API per inviare il comando - dovrebbe fallire senza login
      if (cmdId === 253) {
        // getBatteryInfo
        await api.getBatteryInfo(0);
      } else if (cmdId === 93) {
        // ping
        await api.ping();
      }
      
      const responseTime = Date.now() - startTime;
      log(`✓ Comando inviato e risposta ricevuta in ${responseTime}ms`);
      return { success: true, responseTimeMs: responseTime, response: responseData };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Se abbiamo ricevuto una risposta prima dell'errore, consideriamolo un successo
      if (responseReceived) {
        log(`⚠️  Comando inviato, risposta ricevuta ma errore durante parsing: ${errorMsg}`);
        return { success: true, responseTimeMs: responseTime, response: responseData };
      }
      
      log(`✗ Comando fallito: ${errorMsg} (dopo ${responseTime}ms)`);
      return {
        success: false,
        responseTimeMs: responseTime,
        error: errorMsg,
      };
    }
  } finally {
    api.client.off("frame", responseHandler);
  }
}

async function main(): Promise<void> {
  logSection("TEST COMANDI SENZA LOGIN");
  console.log(`Configurazione:`);
  console.log(`  Host: ${config.udp.host || "255.255.255.255 (broadcast)"}`);
  console.log(`  Username: ${config.udp.username}`);
  console.log(`  UID: ${config.udp.uid}`);
  console.log(`  Channel: 0`);

  if (!config.udp.uid) {
    throw new Error("Missing UDP_UID in .env (required for BCUDP discovery)");
  }

  const api = new ReolinkBaichuanApi({
    host: config.udp.host || "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debugOptions: { general: true },
  });

  // Ascolta tutti i messaggi per debug
  api.client.on("debug", (event: string, data?: unknown) => {
    if (event.includes("error") || event.includes("disc") || event.includes("timeout")) {
      log(`[DEBUG] ${event}`, data);
    }
  });

  api.client.on("frame", (frame: any) => {
    log(`[FRAME] Ricevuto: cmdId=${frame.header.cmdId}, responseCode=${frame.header.responseCode}, bodyLen=${frame.body.length}`);
  });

  try {
    // TEST: getBatteryInfo senza login
    log(`\n${"=".repeat(60)}`);
    log(`TEST: getBatteryInfo (cmd_id 253) senza login`);
    log(`${"=".repeat(60)}`);
    
    const result = await sendCommandWithoutLogin(api, 253, "getBatteryInfo", 10000);
    
    if (result.success) {
      log(`\n✓✓✓ SUCCESSO: getBatteryInfo funziona SENZA login!`);
      log(`  La camera ha risposto in ${result.responseTimeMs}ms`);
      log(`  Questo significa che il comando NON svegliante può essere inviato senza login`);
      if (result.response) {
        log(`  Dettagli risposta:`, result.response);
      }
    } else {
      log(`\n✗✗✗ FALLITO: getBatteryInfo non funziona senza login`);
      log(`  Errore: ${result.error}`);
      log(`  Questo significa che serve il login per inviare comandi`);
    }

    // Riepilogo
    log(`\n${"=".repeat(60)}`);
    log(`RIEPILOGO`);
    log(`${"=".repeat(60)}`);
    log(`getBatteryInfo senza login: ${result.success ? "✓✓✓ FUNZIONA" : "✗✗✗ NON FUNZIONA"}`);
    log(`Tempo di risposta: ${result.responseTimeMs}ms`);
    
    if (result.success) {
      log(`\n⚠️  IMPORTANTE: getBatteryInfo funziona senza login!`);
      log(`  Questo significa che possiamo verificare lo stato della camera senza svegliarla`);
      log(`  ATTENZIONE: Verifica se la camera si è svegliata quando hai inviato questo comando!`);
    } else {
      log(`\n✓ Come previsto, i comandi richiedono il login`);
    }

    await api.close();
  } catch (error) {
    log(`Errore durante il test:`, error);
    try {
      await api.close();
    } catch {
      // Ignora errori di chiusura
    }
    throw error;
  }
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});


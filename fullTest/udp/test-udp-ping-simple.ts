#!/usr/bin/env node
/**
 * Test semplice per verificare il ping UDP prima e dopo il login.
 * 
 * Sequenza:
 * 1. Ping camera senza login (dovrebbe andare in timeout)
 * 2. Login
 * 3. Ping di nuovo (dovrebbe rispondere)
 * 4. Aspetta 20 secondi
 * 5. Ping di nuovo (per vedere se la camera è ancora sveglia)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";
import dgram from "node:dgram";

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
 * Prova a fare ping UDP senza login (solo discovery - prova a connettersi senza login)
 */
async function pingWithoutLogin(uid: string, timeoutMs: number = 5000): Promise<{ success: boolean; responseTimeMs: number; error?: string }> {
  logSection("TEST 1: Ping senza login");
  
  log(`Tentativo di connessione UDP senza login (solo discovery)...`);
  
  const api = new ReolinkBaichuanApi({
    host: config.udp.host || "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debugOptions: { general: false },
  });

  const startTime = Date.now();
  let connected = false;
  
  // Ascolta eventi di connessione
  api.client.on("debug", (event: string) => {
    if (event === "udp_discovery_success" || event.includes("connected")) {
      connected = true;
    }
  });

  try {
    // Prova a connettere (ma non fare login)
    const udpStream = (api.client as any).udpSocket;
    if (!udpStream) {
      await (api.client as any).connectUdp();
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Attendi discovery
    }
    
    const responseTime = Date.now() - startTime;
    
    const isConnected = (api.client as any).udpSocket?.isConnected?.() || false;
    
    await api.close();
    
    if (isConnected || connected) {
      log(`✓ Discovery riuscito senza login in ${responseTime}ms`);
      return { success: true, responseTimeMs: responseTime };
    } else {
      log(`✗ Discovery fallito senza login (dopo ${responseTime}ms)`);
      return { 
        success: false, 
        responseTimeMs: responseTime,
        error: "Timeout - nessuna risposta al discovery"
      };
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    try {
      await api.close();
    } catch {
      // Ignora errori di chiusura
    }
    return {
      success: false,
      responseTimeMs: responseTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Ping dopo login usando l'API
 */
async function pingWithLogin(api: ReolinkBaichuanApi): Promise<{ success: boolean; responseTimeMs: number; error?: string }> {
  const startTime = Date.now();
  try {
    await api.ping();
    const responseTime = Date.now() - startTime;
    return { success: true, responseTimeMs: responseTime };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      success: false,
      responseTimeMs: responseTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main(): Promise<void> {
  logSection("TEST PING UDP SEMPLICE");
  console.log(`Configurazione:`);
  console.log(`  Host: ${config.udp.host || "255.255.255.255 (broadcast)"}`);
  console.log(`  Username: ${config.udp.username}`);
  console.log(`  UID: ${config.udp.uid}`);
  console.log(`  Channel: 0`);

  if (!config.udp.uid) {
    throw new Error("Missing UDP_UID in .env (required for BCUDP discovery)");
  }

  // TEST 1: Ping senza login
  log(`\n${"=".repeat(60)}`);
  log(`TEST 1: Ping senza login`);
  log(`${"=".repeat(60)}`);
  const ping1 = await pingWithoutLogin(config.udp.uid, 5000);
  
  if (ping1.success) {
    log(`✓ Ping riuscito senza login in ${ping1.responseTimeMs}ms`);
  } else {
    log(`✗ Ping fallito senza login: ${ping1.error} (dopo ${ping1.responseTimeMs}ms)`);
  }

  // TEST 2: Login
  log(`\n${"=".repeat(60)}`);
  log(`TEST 2: Login`);
  log(`${"=".repeat(60)}`);
  
  const api = new ReolinkBaichuanApi({
    host: config.udp.host || "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debugOptions: { general: false },
  });

  try {
    const loginStart = Date.now();
    await api.login();
    const loginDuration = Date.now() - loginStart;
    log(`✓ Login completato in ${loginDuration}ms`);

    // TEST 3: Ping dopo login
    log(`\n${"=".repeat(60)}`);
    log(`TEST 3: Ping dopo login`);
    log(`${"=".repeat(60)}`);
    const ping2 = await pingWithLogin(api);
    
    if (ping2.success) {
      log(`✓ Ping riuscito dopo login in ${ping2.responseTimeMs}ms`);
    } else {
      log(`✗ Ping fallito dopo login: ${ping2.error} (dopo ${ping2.responseTimeMs}ms)`);
    }

    // TEST 4: Attesa 20 secondi
    log(`\n${"=".repeat(60)}`);
    log(`TEST 4: Attesa 20 secondi`);
    log(`${"=".repeat(60)}`);
    log(`Attendo 20 secondi senza inviare comandi...`);
    
    const waitStart = Date.now();
    await sleep(20_000);
    const waitDuration = Date.now() - waitStart;
    log(`Attesa completata (${waitDuration}ms)`);

    // TEST 5: Ping dopo attesa
    log(`\n${"=".repeat(60)}`);
    log(`TEST 5: Ping dopo 20 secondi di attesa`);
    log(`${"=".repeat(60)}`);
    const ping3 = await pingWithLogin(api);
    
    if (ping3.success) {
      log(`✓ Ping riuscito dopo attesa in ${ping3.responseTimeMs}ms`);
      log(`  La camera è ancora sveglia dopo 20 secondi di inattività`);
    } else {
      log(`✗ Ping fallito dopo attesa: ${ping3.error} (dopo ${ping3.responseTimeMs}ms)`);
      log(`  La camera potrebbe essere andata in sleep`);
    }

    // Riepilogo
    log(`\n${"=".repeat(60)}`);
    log(`RIEPILOGO`);
    log(`${"=".repeat(60)}`);
    log(`1. Ping senza login: ${ping1.success ? "✓" : "✗"} (${ping1.responseTimeMs}ms)`);
    log(`2. Login: ✓ (${loginDuration}ms)`);
    log(`3. Ping dopo login: ${ping2.success ? "✓" : "✗"} (${ping2.responseTimeMs}ms)`);
    log(`4. Attesa: ✓ (${waitDuration}ms)`);
    log(`5. Ping dopo attesa: ${ping3.success ? "✓" : "✗"} (${ping3.responseTimeMs}ms)`);
    
    if (ping1.success) {
      log(`\n⚠️  Nota: La camera risponde anche senza login (discovery funziona)`);
    } else {
      log(`\n✓ La camera non risponde senza login (come previsto)`);
    }
    
    if (ping3.success) {
      log(`✓ La camera rimane sveglia dopo 20 secondi di inattività`);
    } else {
      log(`⚠️  La camera potrebbe essere andata in sleep dopo 20 secondi`);
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


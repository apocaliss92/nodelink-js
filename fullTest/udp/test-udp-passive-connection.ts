#!/usr/bin/env node
/**
 * Test per verificare se possiamo rimanere connessi alla camera UDP senza svegliarla.
 * 
 * Strategie testate:
 * 1. Connessione passiva: login e poi nessun comando, solo ascolto
 * 2. Monitoraggio messaggi D2C_DISC dalla camera
 * 3. Verifica stato sleep periodica senza inviare comandi sveglianti
 * 4. Test con e senza heartbeat/ACK automatici
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

interface TestStats {
  startTime: number;
  lastRxAt: number | undefined;
  lastTxAt: number | undefined;
  disconnectReceived: boolean;
  disconnectTime: number | undefined;
  sleepStatusChecks: Array<{ time: number; state: string; reason: string }>;
  messagesReceived: number;
  heartbeatCount: number;
  ackCount: number;
}

async function testPassiveConnection(durationMs: number): Promise<TestStats> {
  logSection(`TEST: Connessione passiva per ${durationMs}ms`);
  
  const stats: TestStats = {
    startTime: Date.now(),
    lastRxAt: undefined,
    lastTxAt: undefined,
    disconnectReceived: false,
    disconnectTime: undefined,
    sleepStatusChecks: [],
    messagesReceived: 0,
    heartbeatCount: 0,
    ackCount: 0,
  };

  const api = new ReolinkBaichuanApi({
    host: config.udp.host || "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debugOptions: { general: false }, // Disabilita debug verboso
  });

  // Traccia messaggi debug per contare heartbeat e ACK
  api.client.on("debug", (event: string, data?: unknown) => {
    if (event === "udp_hb_send") {
      stats.heartbeatCount++;
    }
    if (event === "ack_sent_100" || event === "ack_scheduled") {
      stats.ackCount += 100; // Approssimazione
    }
    
    // Cerca messaggi D2C_DISC
    if (event === "discovery_disc_rx_connected") {
      stats.disconnectReceived = true;
      stats.disconnectTime = Date.now();
      log(`⚠️  D2C_DISC ricevuto dalla camera (disconnect)`, data);
    }
  });

  // Traccia frame ricevuti
  api.client.on("frame", () => {
    stats.messagesReceived++;
    stats.lastRxAt = Date.now();
  });

  // Traccia errori
  api.client.on("error", (error: Error) => {
    log(`[ERROR] Errore client:`, error.message);
    if (error.message.includes("D2C_DISC") || error.message.includes("disconnected")) {
      stats.disconnectReceived = true;
      stats.disconnectTime = Date.now();
    }
  });

  try {
    // Login iniziale
    log(`Connessione e login...`);
    const loginStart = Date.now();
    await api.login();
    const loginDuration = Date.now() - loginStart;
    log(`Login completato in ${loginDuration}ms`);
    
    stats.lastTxAt = Date.now();
    
    // Verifica stato iniziale
    const initialSleepStatus = api.getSleepStatus({ channel: 0 });
    stats.sleepStatusChecks.push({
      time: Date.now() - stats.startTime,
      state: initialSleepStatus.state,
      reason: initialSleepStatus.reason,
    });
    log(`Stato sleep iniziale:`, initialSleepStatus);

    // Attendi senza inviare comandi
    log(`\nInizio periodo passivo (${durationMs}ms)...`);
    log(`Non invieremo comandi, solo ascolteremo i messaggi dalla camera.`);
    log(`Heartbeat e ACK vengono inviati automaticamente dal client.`);

    const checkInterval = 5000; // Controlla ogni 5 secondi
    const endTime = Date.now() + durationMs;
    let checkCount = 0;

    while (Date.now() < endTime && !stats.disconnectReceived) {
      await sleep(Math.min(checkInterval, endTime - Date.now()));
      
      checkCount++;
      const elapsed = Date.now() - stats.startTime;
      
      // Verifica stato sleep (senza inviare comandi)
      const sleepStatus = api.getSleepStatus({ channel: 0 });
      stats.sleepStatusChecks.push({
        time: elapsed,
        state: sleepStatus.state,
        reason: sleepStatus.reason,
      });

      const lastRxAgo = stats.lastRxAt ? Date.now() - stats.lastRxAt : undefined;
      const lastTxAgo = stats.lastTxAt ? Date.now() - stats.lastTxAt : undefined;
      
      log(
        `[${checkCount}] Elapsed: ${elapsed}ms | ` +
        `Sleep: ${sleepStatus.state} | ` +
        `Messages: ${stats.messagesReceived} | ` +
        `HB: ${stats.heartbeatCount} | ` +
        `LastRX: ${lastRxAgo ? `${lastRxAgo}ms ago` : "never"} | ` +
        `LastTX: ${lastTxAgo ? `${lastTxAgo}ms ago` : "never"}`
      );

      // Se la camera è in sleep, verifica se possiamo ancora comunicare
      if (sleepStatus.state === "sleeping") {
        log(`⚠️  Camera rilevata in sleep dopo ${elapsed}ms`);
      }
    }

    if (stats.disconnectReceived) {
      log(`\n⚠️  Camera ha inviato D2C_DISC dopo ${stats.disconnectTime! - stats.startTime}ms`);
    } else {
      log(`\n✓ Connessione mantenuta per ${durationMs}ms senza disconnect`);
    }

    // Verifica finale: prova un comando non svegliante per vedere se la camera risponde
    log(`\nVerifica finale: invio ping per verificare se la camera risponde...`);
    try {
      const pingStart = Date.now();
      await api.ping();
      const pingDuration = Date.now() - pingStart;
      log(`✓ Ping riuscito in ${pingDuration}ms - camera è sveglia`);
    } catch (error) {
      log(`✗ Ping fallito:`, error instanceof Error ? error.message : String(error));
    }

    await api.close();
    return stats;
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

async function testMultipleStrategies(): Promise<void> {
  logSection("TEST MULTIPLE STRATEGIE");
  console.log(`Configurazione:`);
  console.log(`  Host: ${config.udp.host || "255.255.255.255 (broadcast)"}`);
  console.log(`  Username: ${config.udp.username}`);
  console.log(`  UID: ${config.udp.uid}`);
  console.log(`  Channel: 0`);

  if (!config.udp.uid) {
    throw new Error("Missing UDP_UID in .env (required for BCUDP discovery)");
  }

  // TEST 1: Connessione passiva breve (30 secondi)
  log(`\n${"=".repeat(60)}`);
  log(`TEST 1: Connessione passiva breve (30 secondi)`);
  log(`${"=".repeat(60)}`);
  const stats1 = await testPassiveConnection(30_000);
  
  log(`\nRisultati TEST 1:`);
  log(`- Durata: ${stats1.disconnectTime ? stats1.disconnectTime - stats1.startTime : 30_000}ms`);
  log(`- Disconnect ricevuto: ${stats1.disconnectReceived ? "SÌ" : "NO"}`);
  log(`- Messaggi ricevuti: ${stats1.messagesReceived}`);
  log(`- Heartbeat inviati: ${stats1.heartbeatCount}`);
  log(`- Stato sleep finale: ${stats1.sleepStatusChecks[stats1.sleepStatusChecks.length - 1]?.state || "unknown"}`);
  
  await sleep(5000); // Pausa tra i test

  // TEST 2: Connessione passiva lunga (60 secondi)
  log(`\n${"=".repeat(60)}`);
  log(`TEST 2: Connessione passiva lunga (60 secondi)`);
  log(`${"=".repeat(60)}`);
  const stats2 = await testPassiveConnection(60_000);
  
  log(`\nRisultati TEST 2:`);
  log(`- Durata: ${stats2.disconnectTime ? stats2.disconnectTime - stats2.startTime : 60_000}ms`);
  log(`- Disconnect ricevuto: ${stats2.disconnectReceived ? "SÌ" : "NO"}`);
  log(`- Messaggi ricevuti: ${stats2.messagesReceived}`);
  log(`- Heartbeat inviati: ${stats2.heartbeatCount}`);
  log(`- Stato sleep finale: ${stats2.sleepStatusChecks[stats2.sleepStatusChecks.length - 1]?.state || "unknown"}`);

  // Analisi comparativa
  log(`\n${"=".repeat(60)}`);
  log(`ANALISI COMPARATIVA`);
  log(`${"=".repeat(60)}`);
  
  const test1SleepTransitions = stats1.sleepStatusChecks.filter(
    (check, idx) => idx > 0 && check.state !== stats1.sleepStatusChecks[idx - 1]?.state
  );
  const test2SleepTransitions = stats2.sleepStatusChecks.filter(
    (check, idx) => idx > 0 && check.state !== stats2.sleepStatusChecks[idx - 1]?.state
  );

  log(`\nTransizioni stato sleep TEST 1:`);
  test1SleepTransitions.forEach((t) => {
    log(`  - ${t.time}ms: ${t.state} (${t.reason})`);
  });

  log(`\nTransizioni stato sleep TEST 2:`);
  test2SleepTransitions.forEach((t) => {
    log(`  - ${t.time}ms: ${t.state} (${t.reason})`);
  });

  log(`\nConclusioni:`);
  if (stats1.disconnectReceived && stats2.disconnectReceived) {
    log(`- La camera invia D2C_DISC quando entra in sleep anche con connessione passiva`);
    log(`- Tempo medio prima di disconnect: ${((stats1.disconnectTime! - stats1.startTime) + (stats2.disconnectTime! - stats2.startTime)) / 2}ms`);
  } else if (!stats1.disconnectReceived && !stats2.disconnectReceived) {
    log(`- La camera NON invia D2C_DISC durante connessione passiva`);
    log(`- La connessione può essere mantenuta senza svegliare la camera`);
  } else {
    log(`- Comportamento inconsistente: disconnect ricevuto solo in alcuni casi`);
  }
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});

async function main(): Promise<void> {
  await testMultipleStrategies();
}


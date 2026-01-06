#!/usr/bin/env node
/**
 * Test di ping/wake-up per camera UDP a batteria.
 * 
 * Obiettivi:
 * 1. Connettiti alla camera, misura il tempo dall'init connessione fino alla response di un wake-up command
 * 2. Disconnettiti e immediatamente riconnettiti mandando un comando NON svegliante
 * 3. Disconnettiti, aspetta 40 secondi e connetiti e reinvia un comando non bloccante
 * 4. Ascolta messaggi broadcast per eventi e/o sleep status
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
  console.log(`\n[${fmtNow()}] ${message}`);
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
 * Crea un socket UDP per ascoltare messaggi broadcast dalla camera
 * Logga i messaggi raw per analisi (senza parsing completo per evitare dipendenze interne)
 */
function createBroadcastListener(uid: string): dgram.Socket {
  const sock = dgram.createSocket("udp4");
  
  // Abilita broadcast per ricevere messaggi broadcast
  try {
    sock.setBroadcast(true);
  } catch (e) {
    // Ignora se non supportato
  }
  
  let messageCount = 0;
  
  sock.on("message", (msg, rinfo) => {
    messageCount++;
    
    // Analisi semplice del messaggio senza parsing completo
    // Cerca pattern comuni nei messaggi BCUDP
    const msgStr = msg.toString("utf8", 0, Math.min(msg.length, 1000));
    const hasXml = msgStr.includes("<") && msgStr.includes(">");
    
    // Cerca pattern XML comuni
    const hasSleep = msgStr.includes("sleep") || msgStr.includes("Sleep") || msgStr.includes("SLEEP");
    const hasEvent = msgStr.includes("event") || msgStr.includes("Event") || msgStr.includes("EVENT");
    const hasHb = msgStr.includes("D2C_HB") || msgStr.includes("C2D_HB");
    const hasDisc = msgStr.includes("D2C_DISC");
    const hasCfm = msgStr.includes("D2C_CFM");
    const hasT = msgStr.includes("D2C_T") || msgStr.includes("C2D_T");
    
    if (hasXml) {
      if (hasHb) {
        log(`[BROADCAST #${messageCount}] Heartbeat (HB) ricevuto`, {
          rhost: rinfo.address,
          rport: rinfo.port,
          preview: msgStr.substring(0, 200)
        });
      } else if (hasDisc) {
        log(`[BROADCAST #${messageCount}] Disconnect (DISC) ricevuto`, {
          rhost: rinfo.address,
          rport: rinfo.port,
          preview: msgStr.substring(0, 200)
        });
      } else if (hasCfm) {
        log(`[BROADCAST #${messageCount}] Confirm (CFM) ricevuto`, {
          rhost: rinfo.address,
          rport: rinfo.port,
          preview: msgStr.substring(0, 200)
        });
      } else if (hasT) {
        log(`[BROADCAST #${messageCount}] T message ricevuto`, {
          rhost: rinfo.address,
          rport: rinfo.port,
          preview: msgStr.substring(0, 200)
        });
      } else {
        log(`[BROADCAST #${messageCount}] Messaggio XML ricevuto`, {
          rhost: rinfo.address,
          rport: rinfo.port,
          preview: msgStr.substring(0, 500)
        });
      }
      
      if (hasSleep) {
        log(`[BROADCAST #${messageCount}] ⚠️  Possibile sleep status nell'XML`, {
          preview: msgStr
        });
      }
      if (hasEvent) {
        log(`[BROADCAST #${messageCount}] ⚠️  Possibile evento nell'XML`, {
          preview: msgStr
        });
      }
    } else {
      // Messaggio binario o non XML
      log(`[BROADCAST #${messageCount}] Messaggio binario ricevuto`, {
        rhost: rinfo.address,
        rport: rinfo.port,
        size: msg.length,
        hexPreview: msg.subarray(0, Math.min(32, msg.length)).toString("hex")
      });
    }
  });
  
  sock.on("error", (err) => {
    log(`[BROADCAST] Errore socket`, err);
  });
  
  return sock;
}

async function testWakeUpTiming(api: ReolinkBaichuanApi): Promise<number> {
  logSection("TEST 1: Misura tempo wake-up");
  
  const initTime = Date.now();
  log(`Inizio connessione e login...`);
  
  await api.login();
  const loginTime = Date.now();
  const loginDuration = loginTime - initTime;
  log(`Login completato in ${loginDuration}ms`);
  
  // Ora invia un comando wake-up (getEncXml è un WAKING_COMMAND)
  log(`Invio comando wake-up (getEncXml)...`);
  const wakeUpStartTime = Date.now();
  
  try {
    await api.getEncXml(0);
    const wakeUpEndTime = Date.now();
    const wakeUpDuration = wakeUpEndTime - wakeUpStartTime;
    const totalDuration = wakeUpEndTime - initTime;
    
    log(`Comando wake-up completato in ${wakeUpDuration}ms`);
    log(`Tempo totale dall'init alla risposta wake-up: ${totalDuration}ms`);
    
    return totalDuration;
  } catch (error) {
    const wakeUpEndTime = Date.now();
    const wakeUpDuration = wakeUpEndTime - wakeUpStartTime;
    const totalDuration = wakeUpEndTime - initTime;
    
    log(`Errore durante wake-up dopo ${wakeUpDuration}ms:`, error);
    log(`Tempo totale dall'init alla risposta (errore): ${totalDuration}ms`);
    throw error;
  }
}

async function testNonWakingCommand(api: ReolinkBaichuanApi): Promise<void> {
  logSection("TEST 2: Comando NON svegliante dopo riconnessione immediata");
  
  log(`Chiusura connessione...`);
  await api.close();
  await sleep(500); // Piccola pausa per assicurarsi che la disconnessione sia completa
  
  log(`Riconnessione immediata...`);
  const reconnectStartTime = Date.now();
  await api.login();
  const reconnectEndTime = Date.now();
  log(`Riconnessione completata in ${reconnectEndTime - reconnectStartTime}ms`);
  
  // Prova con ping (cmd_id 93) - probabilmente non svegliante
  log(`Invio comando ping (NON svegliante)...`);
  const pingStartTime = Date.now();
  
  try {
    await api.ping();
    const pingEndTime = Date.now();
    const pingDuration = pingEndTime - pingStartTime;
    log(`Ping completato in ${pingDuration}ms`);
    
    // Prova anche con getBatteryInfo (NONE_WAKING_COMMAND)
    log(`Invio comando getBatteryInfo (NON svegliante)...`);
    const batteryStartTime = Date.now();
    const batteryInfo = await api.getBatteryInfo(0);
    const batteryEndTime = Date.now();
    const batteryDuration = batteryEndTime - batteryStartTime;
    log(`getBatteryInfo completato in ${batteryDuration}ms`, {
      sleeping: batteryInfo.sleeping,
      batteryPercent: batteryInfo.batteryPercent
    });
  } catch (error) {
    log(`Errore durante comando non svegliante:`, error);
    throw error;
  }
}

async function testNonWakingAfterSleep(api: ReolinkBaichuanApi): Promise<void> {
  logSection("TEST 3: Comando NON svegliante dopo 40 secondi di attesa");
  
  log(`Chiusura connessione...`);
  await api.close();
  await sleep(500);
  
  log(`Attesa 40 secondi per permettere alla camera di entrare in sleep...`);
  const waitStartTime = Date.now();
  await sleep(40_000);
  const waitEndTime = Date.now();
  log(`Attesa completata (${waitEndTime - waitStartTime}ms)`);
  
  log(`Riconnessione dopo sleep...`);
  const reconnectStartTime = Date.now();
  await api.login();
  const reconnectEndTime = Date.now();
  log(`Riconnessione completata in ${reconnectEndTime - reconnectStartTime}ms`);
  
  // Prova con ping (cmd_id 93) - probabilmente non svegliante
  log(`Invio comando ping (NON svegliante)...`);
  const pingStartTime = Date.now();
  
  try {
    await api.ping();
    const pingEndTime = Date.now();
    const pingDuration = pingEndTime - pingStartTime;
    log(`Ping completato in ${pingDuration}ms`);
    
    // Prova anche con getBatteryInfo (NONE_WAKING_COMMAND)
    log(`Invio comando getBatteryInfo (NON svegliante)...`);
    const batteryStartTime = Date.now();
    const batteryInfo = await api.getBatteryInfo(0);
    const batteryEndTime = Date.now();
    const batteryDuration = batteryEndTime - batteryStartTime;
    log(`getBatteryInfo completato in ${batteryDuration}ms`, {
      sleeping: batteryInfo.sleeping,
      batteryPercent: batteryInfo.batteryPercent
    });
    
    // Verifica lo stato di sleep
    const sleepStatus = api.getSleepStatus({ channel: 0 });
    log(`Stato sleep dopo comando non svegliante:`, sleepStatus);
  } catch (error) {
    log(`Errore durante comando non svegliante dopo sleep:`, error);
    throw error;
  }
}

async function main(): Promise<void> {
  if (!config.udp.uid) {
    throw new Error("Missing UDP_UID in .env (required for BCUDP discovery)");
  }

  logSection("TEST UDP PING/WAKE-UP");
  console.log(`Configurazione:`);
  console.log(`  Host: ${config.udp.host || "255.255.255.255 (broadcast)"}`);
  console.log(`  Username: ${config.udp.username}`);
  console.log(`  UID: ${config.udp.uid}`);
  console.log(`  Channel: 0`);

  // Crea listener per messaggi broadcast
  log(`Avvio listener broadcast...`);
  const broadcastListener = createBroadcastListener(config.udp.uid);
  
  try {
    await new Promise<void>((resolve, reject) => {
      broadcastListener.bind(0, "0.0.0.0", () => {
        const addr = broadcastListener.address();
        const port = typeof addr === "string" ? 0 : addr.port;
        log(`Listener broadcast attivo sulla porta ${port}`);
        resolve();
      });
      broadcastListener.once("error", reject);
    });
  } catch (error) {
    log(`Errore durante bind del listener broadcast:`, error);
  }

  const api = new ReolinkBaichuanApi({
    host: config.udp.host || "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debugOptions: { general: true },
  });

  // Gestisci eventi debug
  api.client.on("debug", (event: string, data?: unknown) => {
    log(`[DEBUG] ${event}`, data);
  });

  // Gestisci eventi dalla camera
  api.client.on("event", (event: unknown) => {
    log(`[EVENT] Evento ricevuto:`, event);
  });

  // Gestisci errori
  api.client.on("error", (error: Error) => {
    log(`[ERROR] Errore client:`, error);
  });

  try {
    // TEST 1: Misura tempo wake-up
    const wakeUpDuration = await testWakeUpTiming(api);
    log(`\n✓ TEST 1 completato: Tempo wake-up = ${wakeUpDuration}ms`);

    // TEST 2: Comando non svegliante dopo riconnessione immediata
    await testNonWakingCommand(api);
    log(`\n✓ TEST 2 completato: Comando non svegliante dopo riconnessione immediata`);

    // TEST 3: Comando non svegliante dopo 40 secondi
    await testNonWakingAfterSleep(api);
    log(`\n✓ TEST 3 completato: Comando non svegliante dopo 40 secondi`);

    // Chiudi connessione
    await api.close();
    log(`\n✓ Tutti i test completati con successo`);
  } catch (error) {
    log(`\n✗ Errore durante i test:`, error);
    try {
      await api.close();
    } catch {
      // Ignora errori di chiusura
    }
    throw error;
  } finally {
    // Chiudi listener broadcast
    broadcastListener.close();
    log(`Listener broadcast chiuso`);
  }
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});


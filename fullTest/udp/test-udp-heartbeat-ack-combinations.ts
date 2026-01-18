#!/usr/bin/env node
/**
 * Test per verificare diverse combinazioni di heartbeat/ACK e lo stato reale della camera.
 * 
 * Strategie testate:
 * 1. Connessione normale (con heartbeat e ACK automatici)
 * 2. Connessione senza heartbeat (solo ACK)
 * 3. Connessione senza ACK (solo heartbeat)
 * 4. Connessione completamente passiva (nessun heartbeat, nessun ACK)
 * 
 * Per ogni strategia, verifichiamo lo stato REALE della camera inviando comandi non sveglianti
 * e misurando i tempi di risposta, ignorando lo stato sleep dedotto dal client.
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

interface ProbeResult {
  success: boolean;
  responseTimeMs: number;
  error?: string;
}

/**
 * Verifica lo stato REALE della camera inviando un comando non svegliante
 */
async function probeCameraState(api: ReolinkBaichuanApi, timeoutMs: number = 5000): Promise<ProbeResult> {
  const startTime = Date.now();
  try {
    await Promise.race([
      api.ping(),
      new Promise<void>((_, reject) => 
        setTimeout(() => reject(new Error("Timeout")), timeoutMs)
      )
    ]);
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

interface TestStrategy {
  name: string;
  description: string;
  disableHeartbeat: boolean;
  disableAck: boolean;
}

const strategies: TestStrategy[] = [
  {
    name: "Normale",
    description: "Heartbeat e ACK automatici (comportamento standard)",
    disableHeartbeat: false,
    disableAck: false,
  },
  {
    name: "Solo ACK",
    description: "Solo ACK, nessun heartbeat",
    disableHeartbeat: true,
    disableAck: false,
  },
  {
    name: "Solo Heartbeat",
    description: "Solo heartbeat, nessun ACK",
    disableHeartbeat: false,
    disableAck: true,
  },
  {
    name: "Passiva",
    description: "Nessun heartbeat, nessun ACK",
    disableHeartbeat: true,
    disableAck: true,
  },
];

/**
 * Intercetta e blocca heartbeat/ACK inviati dal client
 * Nota: questo è un workaround - idealmente dovremmo avere un'opzione nel client
 */
class HeartbeatAckInterceptor {
  private originalSend: typeof dgram.Socket.prototype.send;
  private sock: dgram.Socket | undefined;
  private blockHeartbeat: boolean;
  private blockAck: boolean;
  private heartbeatCount: number = 0;
  private ackCount: number = 0;
  private blockedHeartbeatCount: number = 0;
  private blockedAckCount: number = 0;

  constructor(sock: dgram.Socket, blockHeartbeat: boolean, blockAck: boolean) {
    this.sock = sock;
    this.blockHeartbeat = blockHeartbeat;
    this.blockAck = blockAck;
    this.originalSend = sock.send.bind(sock);
    
    // Intercetta i messaggi
    sock.send = ((buffer: Buffer, ...args: any[]) => {
      // Analizza il buffer per capire se è heartbeat o ACK
      // Heartbeat: magic 0x2a87cf3a (discovery packet) con C2D_HB nell'XML
      // ACK: magic 0x2a87cf20
      
      if (buffer.length >= 4) {
        const magic = buffer.readUInt32LE(0);
        
        // ACK packet
        if (magic === 0x2a87cf20) {
          this.ackCount++;
          if (this.blockAck) {
            this.blockedAckCount++;
            // Non inviare
            return;
          }
        }
        
        // Discovery packet (potrebbe essere heartbeat)
        if (magic === 0x2a87cf3a) {
          // Prova a decodificare per vedere se è heartbeat
          try {
            const xmlStr = buffer.toString("utf8", 20); // Skip header
            if (xmlStr.includes("C2D_HB") || xmlStr.includes("<C2D_HB>")) {
              this.heartbeatCount++;
              if (this.blockHeartbeat) {
                this.blockedHeartbeatCount++;
                // Non inviare
                return;
              }
            }
          } catch {
            // Ignora errori di parsing
          }
        }
      }
      
      // Invia normalmente
      return this.originalSend(buffer, ...args);
    }) as typeof dgram.Socket.prototype.send;
  }

  getStats() {
    return {
      heartbeatSent: this.heartbeatCount - this.blockedHeartbeatCount,
      heartbeatBlocked: this.blockedHeartbeatCount,
      ackSent: this.ackCount - this.blockedAckCount,
      ackBlocked: this.blockedAckCount,
    };
  }

  restore() {
    if (this.sock) {
      this.sock.send = this.originalSend;
    }
  }
}

async function testStrategy(
  strategy: TestStrategy,
  durationMs: number
): Promise<{
  strategy: TestStrategy;
  probeResults: ProbeResult[];
  disconnectReceived: boolean;
  disconnectTime: number | undefined;
  stats: { heartbeatSent: number; heartbeatBlocked: number; ackSent: number; ackBlocked: number };
}> {
  logSection(`TEST: ${strategy.name} - ${strategy.description}`);
  
  const probeResults: ProbeResult[] = [];
  let disconnectReceived = false;
  let disconnectTime: number | undefined;
  let interceptor: HeartbeatAckInterceptor | undefined;

  const api = new ReolinkBaichuanApi({
    host: config.udp.host || "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debugOptions: { general: false },
  });

  // Intercetta disconnect
  api.client.on("error", (error: Error) => {
    if (error.message.includes("D2C_DISC") || error.message.includes("disconnected")) {
      disconnectReceived = true;
      disconnectTime = Date.now();
      log(`⚠️  Disconnect ricevuto:`, error.message);
    }
  });

  try {
    // Login
    log(`Connessione e login...`);
    await api.login();
    log(`Login completato`);

    // Intercetta heartbeat/ACK dopo il login
    // Nota: questo è un hack - accediamo al socket interno
    const udpStream = (api.client as any).udpSocket;
    if (udpStream && (udpStream as any).sock) {
      interceptor = new HeartbeatAckInterceptor(
        (udpStream as any).sock,
        strategy.disableHeartbeat,
        strategy.disableAck
      );
      log(`Interceptor attivo: HB=${strategy.disableHeartbeat ? "bloccato" : "permesso"}, ACK=${strategy.disableAck ? "bloccato" : "permesso"}`);
    } else {
      log(`⚠️  Impossibile accedere al socket UDP - interceptor non attivo`);
    }

    // Attendi un po' per permettere alla camera di stabilizzarsi
    await sleep(2000);

    // Periodo di test
    log(`\nInizio periodo di test (${durationMs}ms)...`);
    const startTime = Date.now();
    const endTime = startTime + durationMs;
    const probeInterval = 10000; // Probe ogni 10 secondi

    let probeCount = 0;
    while (Date.now() < endTime && !disconnectReceived) {
      // Probe dello stato reale
      probeCount++;
      log(`\n[Probe ${probeCount}] Verifica stato reale camera...`);
      const probeResult = await probeCameraState(api);
      probeResults.push(probeResult);
      
      if (probeResult.success) {
        log(`✓ Camera risponde in ${probeResult.responseTimeMs}ms - camera è SVEGLIA`);
      } else {
        log(`✗ Camera non risponde (${probeResult.responseTimeMs}ms) - camera potrebbe essere in SLEEP`);
        if (probeResult.error) {
          log(`  Errore: ${probeResult.error}`);
        }
      }

      // Attendi prima del prossimo probe
      const remainingTime = endTime - Date.now();
      if (remainingTime > probeInterval) {
        await sleep(probeInterval);
      } else if (remainingTime > 0) {
        await sleep(remainingTime);
      }
    }

    // Statistiche finali
    const stats = interceptor?.getStats() || { heartbeatSent: 0, heartbeatBlocked: 0, ackSent: 0, ackBlocked: 0 };
    
    log(`\nStatistiche:`);
    log(`- Heartbeat inviati: ${stats.heartbeatSent}, bloccati: ${stats.heartbeatBlocked}`);
    log(`- ACK inviati: ${stats.ackSent}, bloccati: ${stats.ackBlocked}`);
    log(`- Probe eseguiti: ${probeResults.length}`);
    log(`- Probe riusciti: ${probeResults.filter(r => r.success).length}`);
    log(`- Probe falliti: ${probeResults.filter(r => !r.success).length}`);
    if (disconnectReceived) {
      log(`- Disconnect ricevuto dopo: ${disconnectTime! - startTime}ms`);
    }

    interceptor?.restore();
    await api.close();
    
    return {
      strategy,
      probeResults,
      disconnectReceived,
      disconnectTime,
      stats,
    };
  } catch (error) {
    log(`Errore durante il test:`, error);
    interceptor?.restore();
    try {
      await api.close();
    } catch {
      // Ignora errori di chiusura
    }
    throw error;
  }
}

async function main(): Promise<void> {
  logSection("TEST COMBINAZIONI HEARTBEAT/ACK");
  console.log(`Configurazione:`);
  console.log(`  Host: ${config.udp.host || "255.255.255.255 (broadcast)"}`);
  console.log(`  Username: ${config.udp.username}`);
  console.log(`  UID: ${config.udp.uid}`);
  console.log(`  Channel: 0`);

  if (!config.udp.uid) {
    throw new Error("Missing UDP_UID in .env (required for BCUDP discovery)");
  }

  const results = [];

  for (const strategy of strategies) {
    log(`\n${"=".repeat(60)}`);
    log(`Esecuzione strategia: ${strategy.name}`);
    log(`${"=".repeat(60)}`);
    
    const result = await testStrategy(strategy, 60_000); // 60 secondi per strategia
    results.push(result);
    
    // Pausa tra i test
    if (strategy !== strategies[strategies.length - 1]) {
      log(`\nPausa 10 secondi prima del prossimo test...`);
      await sleep(10_000);
    }
  }

  // Analisi comparativa
  logSection("ANALISI COMPARATIVA");
  
  for (const result of results) {
    log(`\n${result.strategy.name}:`);
    log(`- Disconnect: ${result.disconnectReceived ? "SÌ" : "NO"}`);
    log(`- Probe riusciti: ${result.probeResults.filter(r => r.success).length}/${result.probeResults.length}`);
    const avgResponseTime = result.probeResults
      .filter(r => r.success)
      .reduce((sum, r) => sum + r.responseTimeMs, 0) / 
      (result.probeResults.filter(r => r.success).length || 1);
    log(`- Tempo medio risposta: ${Math.round(avgResponseTime)}ms`);
    log(`- Heartbeat: ${result.stats.heartbeatSent} inviati, ${result.stats.heartbeatBlocked} bloccati`);
    log(`- ACK: ${result.stats.ackSent} inviati, ${result.stats.ackBlocked} bloccati`);
  }

  log(`\n${"=".repeat(60)}`);
  log(`CONCLUSIONI`);
  log(`${"=".repeat(60)}`);
  
  const strategiesWithDisconnect = results.filter(r => r.disconnectReceived);
  const strategiesWithoutDisconnect = results.filter(r => !r.disconnectReceived);
  
  if (strategiesWithDisconnect.length > 0) {
    log(`\nStrategie che causano disconnect:`);
    strategiesWithDisconnect.forEach(r => {
      log(`- ${r.strategy.name}: disconnect dopo ${r.disconnectTime ? "N/A" : "N/A"}ms`);
    });
  }
  
  if (strategiesWithoutDisconnect.length > 0) {
    log(`\nStrategie che mantengono la connessione:`);
    strategiesWithoutDisconnect.forEach(r => {
      const successRate = (r.probeResults.filter(p => p.success).length / r.probeResults.length) * 100;
      log(`- ${r.strategy.name}: ${successRate.toFixed(1)}% probe riusciti`);
    });
  }
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});


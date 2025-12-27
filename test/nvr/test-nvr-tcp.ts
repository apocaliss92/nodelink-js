#!/usr/bin/env node
/**
 * Suite di test completa per NVR via protocollo Baichuan TCP
 * Testa: login, ping, lista canali, info per ogni canale, network, ports, encoding
 */

import { ReolinkNvrHybridApi } from "../../dist/index.js";
import { config } from "../env.js";

// Funzioni helper
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📹 ${message}`);
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

async function runNvrTcpTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         TEST SUITE NVR TCP - REOLINK BAICHUAN             ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfigurazione:`);
  console.log(`  Host: ${config.nvr.host}`);
  console.log(`  Username: ${config.nvr.username}\n`);

  const api = new ReolinkNvrHybridApi({
    cgi: {
      host: config.nvr.host,
      username: config.nvr.username,
      password: config.nvr.password,
      useHttps: false,
    },
    baichuan: {
      host: config.nvr.host,
      username: config.nvr.username,
      password: config.nvr.password,
      transport: "tcp",
      debug: false,
    },
  });

  const results: Record<string, boolean> = {};

  try {
    // ========== TEST 1: LOGIN ==========
    log("Test 1: Login NVR (CGI + Baichuan TCP)");
    await api.login();
    logSuccess("Login NVR riuscito!");
    results.login = true;

    // ========== TEST 2: LISTA CANALI ==========
    log("Test 2: ListChannels - Lista canali disponibili");
    
    // Debug: vediamo la risposta raw di GetChannelstatus PRIMA di estrarre i canali
    let rawStatus: any = null;
    if (api.cgi) {
      try {
        rawStatus = await api.cgi.getChannelStatus();
        console.log("\n" + "=".repeat(60));
        console.log("🔍 DEBUG: Risposta raw GetChannelstatus:");
        console.log("=".repeat(60));
        console.log(JSON.stringify(rawStatus, null, 2));
        console.log("\n" + "=".repeat(60));
        console.log("🔍 DEBUG: Struttura valore primo elemento:");
        console.log("=".repeat(60));
        if (rawStatus && rawStatus[0] && rawStatus[0].value) {
          console.log(JSON.stringify(rawStatus[0].value, null, 2));
        } else {
          console.log("⚠️  rawStatus[0]?.value non disponibile");
          console.log("rawStatus[0]:", rawStatus?.[0]);
        }
        console.log("=".repeat(60) + "\n");
      } catch (error) {
        console.error("❌ Errore durante GetChannelstatus:", error);
      }
    }
    
    const channels = await api.listChannels();
    log("Canali disponibili", { channels, count: channels.length });
    if (channels.length === 0) {
      console.log("⚠️  Nessun canale trovato - NVR potrebbe non avere videocamere collegate");
      console.log("⚠️  Controlla la risposta raw sopra per capire la struttura dei dati");
      // Non uscire subito, continuiamo per vedere altri test
    }
    logSuccess(`ListChannels riuscito! Trovati ${channels.length} canali`);
    results.listChannels = true;

    if (channels.length === 0) {
      console.log("\n⚠️  Nessun canale disponibile, salto i test per canale");
      // Continuiamo comunque con altri test che non richiedono canali
    }

    // ========== TEST 3: INFO TUTTE LE VIDEOCAMERE ==========
    log("Test 3: GetAllConnectedCamerasInfo - Info per tutte le videocamere");
    const allCamerasInfo = await api.getAllConnectedCamerasInfo();
    log("Info tutte le videocamere", allCamerasInfo);
    logSuccess(`GetAllConnectedCamerasInfo riuscito! Info per ${Object.keys(allCamerasInfo).length} canali`);
    results.allCamerasInfo = true;

    // ========== TEST 4: INFO PER OGNI CANALE (Baichuan) ==========
    if (api.baichuan) {
      log("Test 4: Baichuan - Info dettagliate per ogni canale");
      const baichuanInfo = await api.baichuan.getAllInfo(channels);
      log("Info Baichuan per canali", baichuanInfo);
      logSuccess(`Baichuan getAllInfo riuscito! Info per ${Object.keys(baichuanInfo).length} canali`);
      results.baichuanInfo = true;

      // ========== TEST 5: NETWORK PORTS (Host) ==========
      log("Test 5: GetPorts - Porte di rete NVR (host)");
      const ports = await api.baichuan.bc.getPorts();
      log("Porte di rete NVR", ports);
      logSuccess("GetPorts NVR riuscito!");
      results.ports = true;

      // ========== TEST 6: GENERAL INFO (Host) ==========
      log("Test 6: GetGeneralXml - Informazioni generali NVR (Network, MAC, etc.)");
      const generalXml = await api.baichuan.bc.getGeneralXml();
      log("General XML NVR (primi 500 caratteri)", generalXml.substring(0, 500));
      logSuccess("GetGeneralXml NVR riuscito!");
      results.generalInfo = true;

      // ========== TEST 7: ENCODING INFO PER OGNI CANALE ==========
      log("Test 7: GetEncXml - Informazioni encoding per ogni canale");
      const encodingInfo: Record<number, string> = {};
      for (const channel of channels.slice(0, 3)) { // Limita a primi 3 canali per non sovraccaricare
        try {
          const encXml = await api.baichuan.bc.getEncXml(channel);
          encodingInfo[channel] = encXml.substring(0, 200); // Primi 200 caratteri
          console.log(`  ✓ Canale ${channel}: encoding info recuperato`);
        } catch (error) {
          console.log(`  ✗ Canale ${channel}: errore - ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      log("Encoding info (primi canali)", encodingInfo);
      logSuccess(`GetEncXml riuscito per ${Object.keys(encodingInfo).length} canali`);
      results.encoding = Object.keys(encodingInfo).length > 0;
    }

    // ========== TEST 8: CHANNEL STATUS (CGI) ==========
    if (api.cgi) {
      log("Test 8: GetChannelStatus - Stato dettagliato canali (CGI)");
      const channelStatus = await api.cgi.getChannelStatus();
      log("Channel Status (primi 500 caratteri)", JSON.stringify(channelStatus, null, 2).substring(0, 500));
      logSuccess("GetChannelStatus riuscito!");
      results.channelStatus = true;

      // ========== TEST 9: DEV INFO PER OGNI CANALE (CGI) ==========
      log("Test 9: GetAllDevInfo - Device info per ogni canale (CGI)");
      const allDevInfo = await api.cgi.getAllDevInfo();
      log("All Dev Info (primi canali)", Object.fromEntries(Object.entries(allDevInfo).slice(0, 2)));
      logSuccess(`GetAllDevInfo riuscito! Info per ${Object.keys(allDevInfo).length} canali`);
      results.allDevInfo = true;

      // ========== TEST 10: CHN TYPE INFO ==========
      log("Test 10: GetAllChnTypeInfo - Tipo info per ogni canale");
      const allChnTypeInfo = await api.cgi.getAllChnTypeInfo();
      log("All Chn Type Info (primi canali)", Object.fromEntries(Object.entries(allChnTypeInfo).slice(0, 2)));
      logSuccess(`GetAllChnTypeInfo riuscito! Info per ${Object.keys(allChnTypeInfo).length} canali`);
      results.allChnTypeInfo = true;
    }

    // Chiusura connessione
    await api.close();
    logSuccess("Connessione NVR chiusa correttamente");

    // Riepilogo
    console.log("\n\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                  RIEPILOGO TEST NVR TCP                  ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    const testNames: Record<string, string> = {
      login: "Login",
      listChannels: "List Channels",
      allCamerasInfo: "All Cameras Info (Hybrid)",
      baichuanInfo: "Baichuan Info (per canale)",
      ports: "Network Ports (Host)",
      generalInfo: "General Info (Host)",
      encoding: "Encoding Info (per canale)",
      channelStatus: "Channel Status (CGI)",
      allDevInfo: "All Dev Info (CGI)",
      allChnTypeInfo: "All Chn Type Info (CGI)",
    };
    for (const [key, name] of Object.entries(testNames)) {
      console.log(`${name.padEnd(35)}: ${results[key] ? "✅ SUCCESSO" : "❌ FALLITO"}`);
    }
    const successCount = Object.values(results).filter((r) => r).length;
    console.log(`\nTest completati con successo: ${successCount}/${Object.keys(results).length}\n`);

    return successCount === Object.keys(results).length;
  } catch (error) {
    logError("Errore durante test NVR TCP", error);
    try {
      await api.close();
    } catch {
      // Ignora errori di chiusura
    }
    return false;
  }
}

// Esegui i test
runNvrTcpTests()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    logError("Errore fatale", error);
    process.exit(1);
  });


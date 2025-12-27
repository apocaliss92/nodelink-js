#!/usr/bin/env node
/**
 * Suite di test completa per protocollo Baichuan TCP
 * Testa: login, ping, device info, network, ports, encoding, general info
 */

import { ReolinkBaichuanApi } from "../../dist/index.js";
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

async function runTcpTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         TEST SUITE TCP - REOLINK BAICHUAN                ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfigurazione:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: false,
  });

  // Gestisci errori
  api.client.on("error", () => {
    // Errori gestiti nei try-catch
  });

  const results: Record<string, boolean> = {};

  try {
    // ========== TEST 1: LOGIN ==========
    log("Test 1: Login TCP");
    await api.login();
    logSuccess("Login TCP riuscito!");
    results.login = true;

    // ========== TEST 2: PING ==========
    log("Test 2: Ping TCP");
    await api.ping();
    logSuccess("Ping TCP riuscito!");
    results.ping = true;

    // ========== TEST 3: DEVICE INFO ==========
    log("Test 3: GetInfo - Informazioni dispositivo");
    const deviceInfo = await api.getInfo();
    log("Informazioni dispositivo", deviceInfo);
    logSuccess("GetInfo TCP riuscito!");
    results.deviceInfo = true;

    // ========== TEST 4: NETWORK PORTS ==========
    log("Test 4: GetPorts - Porte di rete");
    const ports = await api.getPorts();
    log("Porte di rete", ports);
    logSuccess("GetPorts TCP riuscito!");
    results.ports = true;

    // ========== TEST 5: GENERAL INFO (Network, MAC, etc.) ==========
    log("Test 5: GetGeneralXml - Informazioni generali (Network, MAC, etc.)");
    const generalXml = await api.getGeneralXml();
    log("General XML (primi 500 caratteri)", generalXml.substring(0, 500));
    logSuccess("GetGeneralXml TCP riuscito!");
    results.generalInfo = true;

    // ========== TEST 6: ENCODING INFO ==========
    log("Test 6: GetEncXml - Informazioni encoding");
    const encXml = await api.getEncXml(0);
    log("Encoding XML (primi 500 caratteri)", encXml.substring(0, 500));
    logSuccess("GetEncXml TCP riuscito!");
    results.encoding = true;

    // Chiusura connessione
    await api.close();
    logSuccess("Connessione TCP chiusa correttamente");

    // Riepilogo
    console.log("\n\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    RIEPILOGO TEST TCP                     ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    const testNames: Record<string, string> = {
      login: "Login",
      ping: "Ping",
      deviceInfo: "Device Info",
      ports: "Network Ports",
      generalInfo: "General Info (Network/MAC)",
      encoding: "Encoding Info",
    };
    for (const [key, name] of Object.entries(testNames)) {
      console.log(`${name.padEnd(30)}: ${results[key] ? "✅ SUCCESSO" : "❌ FALLITO"}`);
    }
    const successCount = Object.values(results).filter((r) => r).length;
    console.log(`\nTest completati con successo: ${successCount}/${Object.keys(results).length}\n`);

    return successCount === Object.keys(results).length;
  } catch (error) {
    logError("Errore durante test TCP", error);
    try {
      await api.close();
    } catch {
      // Ignora errori di chiusura
    }
    return false;
  }
}

// Esegui i test
runTcpTests()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    logError("Errore fatale", error);
    process.exit(1);
  });


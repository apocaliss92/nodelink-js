#!/usr/bin/env node
/**
 * Stampa le info dispositivo via Baichuan (GetDevInfo).
 * Serve per identificare modello/firmware direttamente dalla camera (stesso IP).
 */
// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

async function main() {
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

  const maxEnc = (process.env.BAICHUAN_MAX_ENC as any) as "none" | "bc" | "aes" | "full_aes" | undefined;
  await api.login(maxEnc ?? "aes");
  const dev = await api.getInfo(); // cmd_id 80 (host)

  console.log("\n=== DEVINFO (Baichuan) ===");
  console.log(`host: ${config.tcp.host}`);
  console.log(`type: ${dev.type ?? ""}`);
  console.log(`name: ${dev.name ?? ""}`);
  console.log(`hardwareVersion: ${dev.hardwareVersion ?? ""}`);
  console.log(`firmwareVersion: ${dev.firmwareVersion ?? ""}`);
  console.log(`itemNo: ${dev.itemNo ?? ""}`);
  console.log(`serialNumber: ${dev.serialNumber ?? ""}`);

  await api.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



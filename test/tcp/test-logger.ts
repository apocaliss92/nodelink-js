// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config as envConfig } from "../env.js";

const config = envConfig.tcp;

const customLogger = {
  log: (...args: any[]) => console.log("[CUSTOM LOG]", ...args),
  info: (...args: any[]) => console.info("[CUSTOM INFO]", ...args),
  warn: (...args: any[]) => console.warn("[CUSTOM WARN]", ...args),
  error: (...args: any[]) => console.error("[CUSTOM ERROR]", ...args),
  debug: (...args: any[]) => console.debug("[CUSTOM DEBUG]", ...args),
};

async function main() {
  console.log("--- Testing Logger Refactor ---");

  const api = new ReolinkBaichuanApi({
    host: config.host,
    port: 9000, // Default port
    username: config.username,
    password: config.password,
    channel: 0,
    logger: customLogger,
    debug: true, // Enable debug to see logs
  });

  try {
    console.log("Logging in...");
    await api.login();
    console.log("Logged in successfully.");

    // Wait a bit to see keepalive logs
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await api.close();
    console.log("Closed.");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
/**
 * Test to compare Ability Info from Baichuan vs REST API
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, ReolinkCgiApi } from "../../index.js";
import { config } from "../env.js";

// Helper functions
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[INFO] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("=".repeat(60));
}

function logSuccess(message: string) {
  console.log(`\n[OK] ${message}`);
}

async function main() {
  if (!config.tcp.host || !config.tcp.username || !config.tcp.password) {
    console.error("Error: TCP_HOST, TCP_USERNAME, and TCP_PASSWORD must be set in environment or .env file");
    process.exit(1);
  }

  const baichuanApi = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    channel: 0,
  });

  const cgiApi = new ReolinkCgiApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
  });

  try {
    // Login to both
    log("Logging in to Baichuan...");
    await baichuanApi.login();
    logSuccess("Baichuan login successful");

    log("Logging in to REST/CGI API...");
    await cgiApi.login();
    logSuccess("REST/CGI API login successful");

    // Get abilities via Baichuan
    log("\n" + "=".repeat(80));
    log("BAICHUAN API - getAbilityInfo");
    log("=".repeat(80));
    
    // First, let's get the raw XML to see what Baichuan actually returns
    // We need to access sendXml directly, but it's private, so we'll add a debug method
    // For now, let's just call getAbilityInfo and add logging in the implementation
    const baichuanAbilities = await baichuanApi.getAbilityInfo(config.tcp.username);
    log("Baichuan Abilities Result", baichuanAbilities);
    
    // Try to get raw XML by looking at the client (if accessible) - this is just for debugging
    // The actual XML parsing needs to be improved in the implementation

    // Get abilities via REST
    log("\n" + "=".repeat(80));
    log("REST/CGI API - GetAbility");
    log("=".repeat(80));
    const restResponse = await cgiApi.GetAbility(config.tcp.username);
    log("REST API Response", restResponse);
    
    const restAbilities = restResponse[0]?.value;
    
    if (restAbilities) {
      log("REST Abilities Result", restAbilities);
      
      // Compare
      log("\n" + "=".repeat(80));
      log("COMPARISON");
      log("=".repeat(80));
      
      console.log("\nBaichuan returned:");
      console.log(`  - Keys: ${Object.keys(baichuanAbilities).join(", ")}`);
      console.log(`  - Total channels/entries: ${Object.keys(baichuanAbilities).length}`);
      
      for (const [key, value] of Object.entries(baichuanAbilities)) {
        console.log(`  - ${key}:`, value);
      }
      
      if (restAbilities && typeof restAbilities === "object") {
        const restObj = restAbilities as Record<string, unknown>;
        console.log("\nREST returned:");
        console.log(`  - Keys: ${Object.keys(restObj).join(", ")}`);
        console.log(`  - Total top-level keys: ${Object.keys(restObj).length}`);
        
        // Check for Ability structure
        if ("Ability" in restObj) {
          const ability = restObj.Ability as Record<string, unknown>;
          console.log(`  - Ability keys: ${Object.keys(ability).join(", ")}`);
          
          if ("abilityChn" in ability) {
            const abilityChn = ability.abilityChn;
            console.log(`  - abilityChn:`, abilityChn);
          }
          if ("ability" in ability) {
            const hostAbility = ability.ability;
            console.log(`  - ability (host):`, hostAbility);
          }
        }
      }
    }

  } catch (error) {
    log("Fatal error", error);
    throw error;
  } finally {
    try {
      await baichuanApi.close();
      logSuccess("Baichuan connection closed");
    } catch (error) {
      log("Error closing Baichuan", error);
    }
    try {
      await cgiApi.logout();
      logSuccess("REST/CGI connection closed");
    } catch (error) {
      log("Error closing REST/CGI", error);
    }
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

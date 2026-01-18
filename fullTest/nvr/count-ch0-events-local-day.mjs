import "dotenv/config";
import { ReolinkBaichuanApi } from "../../dist/index.js";

const host = process.env.NVR_HOST;
const username = process.env.NVR_USERNAME || "admin";
const password = process.env.NVR_PASSWORD;

if (host == null || host === "" || password == null || password === "") {
  throw new Error("Missing NVR_HOST/NVR_PASSWORD");
}

function dayStartLocal(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

async function countRange(api, label, start, end) {
  const events = await api.listNvrAlarmEventsEnrichedViaCgi({
    start,
    end,
    channels: [0],
    autoSearchByDay: false,
  });

  console.log(`\n${label}`);
  console.log("  start:", start.toString(), "|", start.toISOString());
  console.log("  end  :", end.toString(), "|", end.toISOString());
  console.log("  events:", events.length);

  const motion = events.filter((e) => e.hasMotion).length;
  const person = events.filter((e) => e.hasPerson).length;
  const vehicle = events.filter((e) => e.hasVehicle).length;
  const animal = events.filter((e) => e.hasAnimal).length;
  const other = events.filter((e) => e.hasOther).length;
  console.log("  breakdown motion/person/vehicle/animal/other =", motion, person, vehicle, animal, other);
}

const api = new ReolinkBaichuanApi({ host, username, password, port: 9000 });

const now = new Date();
const startToday = dayStartLocal(now);
const startYesterday = new Date(startToday.getTime() - 24 * 60 * 60 * 1000);
const endYesterday = startToday;

await countRange(api, "EVENTS TODAY (local 00:00 -> now)", startToday, now);
await countRange(api, "EVENTS YESTERDAY (local full day)", startYesterday, endYesterday);

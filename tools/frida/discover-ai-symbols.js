/**
 * Reolink macOS app — phase 1: discovery.
 *
 * Goal: identify which functions inside libBCSDKWrapper.dylib (or peers)
 * fire when an I/P-frame with AI-Mark overlay arrives. Strategy:
 *
 *   1. Enumerate exported and non-stripped local symbols whose name contains
 *      any of the keywords we know are related to the AI overlay feature
 *      (AiTrack, AIDetect, AiMark, drawAIRect, Player, Frame, etc.).
 *   2. Install a lightweight Interceptor on each match that logs the first
 *      N invocations with a backtrace and the first 16 args (just registers).
 *   3. Print module bases so we can compute offsets for static RE.
 *
 * Run with:
 *   frida -p <pid> -l tools/frida/discover-ai-symbols.js
 * where <pid> is the main Reolink process (the one that loaded the .dylibs,
 * NOT the helper/renderer processes).
 */

const KEYWORDS = [
  "AITrack",
  "AiTrack",
  "AIDetect",
  "AiDetect",
  "AiMark",
  "DrawAIRect",
  "DrawAiRect",
  "drawAIRect",
  "drawAiRect",
  "AIRender",
  "AiRender",
  "PlayerDraw",
  "playerDraw",
  "SmartAI",
  "AiOsd",
  "AIBox",
  "AiBox",
  "TargetBox",
];

const MAX_HITS_PER_SYMBOL = 5;
const MAX_BACKTRACE_FRAMES = 6;

const hits = new Map();

function shouldKeep(name) {
  for (const k of KEYWORDS) {
    if (name.indexOf(k) >= 0) return true;
  }
  return false;
}

function printModule(m) {
  send({
    type: "module",
    name: m.name,
    base: m.base,
    size: m.size,
    path: m.path,
  });
}

function enumerateAndHook() {
  const interesting = [
    "libBCSDKWrapper.dylib",
    "bcsdk.node",
    "libopencv_world.4.12.0.dylib",
    "Reolink",
    "Reolink Helper",
  ];

  const allModules = Process.enumerateModules();
  const targets = allModules.filter((m) => {
    const lower = m.name.toLowerCase();
    return interesting.some((p) => lower.indexOf(p.toLowerCase()) >= 0);
  });
  for (const m of targets) printModule(m);

  for (const mod of targets) {
    const sym = mod.enumerateSymbols();
    for (const s of sym) {
      const name = s.name;
      if (!shouldKeep(name)) continue;
      if (s.address.isNull()) continue;

      send({ type: "symbol", module: mod.name, addr: s.address, name });

      // Skip data symbols — only hook code.
      if (s.type !== "function") continue;

      try {
        Interceptor.attach(s.address, {
          onEnter(args) {
            const key = `${mod.name}!${name}`;
            const n = (hits.get(key) ?? 0) + 1;
            hits.set(key, n);
            if (n > MAX_HITS_PER_SYMBOL) return;

            const argDump = [];
            for (let i = 0; i < 4; i++) {
              try {
                argDump.push(args[i].toString());
              } catch (_) {
                argDump.push("?");
              }
            }

            const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
              .slice(0, MAX_BACKTRACE_FRAMES)
              .map(DebugSymbol.fromAddress)
              .map((d) => d.toString());

            send({
              type: "hit",
              symbol: name,
              module: mod.name,
              hitN: n,
              args: argDump,
              backtrace: bt,
            });
          },
        });
      } catch (e) {
        send({ type: "hook-error", symbol: name, error: String(e) });
      }
    }
  }

  send({
    type: "ready",
    note: "Discovery hooks installed. Trigger AI Mark on/off in the app now.",
  });
}

rpc.exports = {
  init() {
    try {
      enumerateAndHook();
    } catch (e) {
      send({ type: "fatal", error: String(e) });
    }
  },
};

// Auto-start when loaded via `frida -l <script>`.
setTimeout(() => {
  try {
    enumerateAndHook();
  } catch (e) {
    send({ type: "fatal", error: String(e) });
  }
}, 100);

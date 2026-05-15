// Standalone probe that calls Reolink's AIDataParser::parseAIData directly,
// without needing to attach to the running app.
//
// Usage:
//   ./probe <hex-bytes-of-additionalHeader>
//   ./probe < pcap-extracted-header.bin
//
// Builds against libBCSDKWrapper.dylib loaded via dlopen, looking up the
// mangled C++ symbols by name. Output is JSON describing what the SDK
// decoded — empty arrays mean the parser rejected the bytes.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <dlfcn.h>
#include <string>
#include <vector>

namespace bc {
// Forward declarations matching the SDK's mangled signatures:
//   _ZN12AIDataParserC1Ev                              -- AIDataParser::AIDataParser()
//   _ZN12AIDataParserD1Ev                              -- AIDataParser::~AIDataParser()
//   _ZN12AIDataParser11parseAIData...                  -- parseAIData(uint8_t*, int, BC_AI_DATA*, BC_FISH_INFO*, BC_TLV_COMMON_INFO*)
using CtorFn = void (*)(void* /*this*/);
using DtorFn = void (*)(void* /*this*/);
using ParseFn = int (*)(void* /*this*/,
                        uint8_t* /*buf*/, int /*size*/,
                        void* /*BC_AI_DATA*/,
                        void* /*BC_FISH_INFO*/,
                        void* /*BC_TLV_COMMON_INFO*/);

// Empirical class size: ctor calls bzero(this+0x10, 0x1614). So minimum 0x1624.
constexpr size_t AI_DATA_PARSER_SIZE = 0x1700;

// From disasm: parseAIData later does memcpy(BC_AI_DATA, this+0x480, 0xD28).
constexpr size_t BC_AI_DATA_SIZE = 0xD28;

// Helper: hex string -> bytes.
static std::vector<uint8_t> fromHex(const std::string& s) {
  std::vector<uint8_t> out;
  out.reserve(s.size() / 2);
  for (size_t i = 0; i + 1 < s.size(); i += 2) {
    char b[3] = {s[i], s[i + 1], 0};
    out.push_back(static_cast<uint8_t>(strtoul(b, nullptr, 16)));
  }
  return out;
}

// One AI class section is 0x118 = 280 bytes. Empirically (from disasm of
// parseAIData rotation pass):
//   +0x10: width (u16)
//   +0x12: height (u16)
//   +0x14: count of box records (u16)
//   +0x16: array of 16-byte box records
struct AIClassDump {
  uint16_t width;
  uint16_t height;
  uint16_t count;
  uint16_t raw[8];  // first 16 bytes of first record, hex-printed
};

static AIClassDump readClass(const uint8_t* p) {
  AIClassDump d{};
  d.width = *reinterpret_cast<const uint16_t*>(p + 0x10);
  d.height = *reinterpret_cast<const uint16_t*>(p + 0x12);
  d.count = *reinterpret_cast<const uint16_t*>(p + 0x14);
  std::memcpy(d.raw, p + 0x16, sizeof(d.raw));
  return d;
}

static void dumpView(const char* name, const uint8_t* viewBase) {
  printf("    \"%s\": [\n", name);
  for (int cls = 0; cls < 4; cls++) {
    AIClassDump d = readClass(viewBase + cls * 0x118);
    printf("      {\"class\":%d, \"width\":%u, \"height\":%u, \"count\":%u, ",
           cls, d.width, d.height, d.count);
    printf("\"first_record_hex\":\"");
    for (int i = 0; i < 8; i++) printf("%04x", d.raw[i]);
    printf("\"}%s\n", cls == 3 ? "" : ",");
  }
  printf("    ]%s\n", strcmp(name, "view2") == 0 ? "" : ",");
}
}  // namespace bc

int main(int argc, char** argv) {
  using namespace bc;

  if (argc < 3) {
    fprintf(stderr,
            "usage: %s <path/to/libBCSDKWrapper.dylib> <hex-bytes>\n"
            "       %s <path/to/libBCSDKWrapper.dylib> @<bin-file>\n",
            argv[0], argv[0]);
    return 2;
  }

  // 1) Load the SDK.
  void* h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!h) {
    fprintf(stderr, "dlopen failed: %s\n", dlerror());
    return 1;
  }

  // 2) Look up mangled C++ symbols. macOS adds a leading underscore which
  // dlsym strips, so we use the names as they appear in nm minus the underscore.
  auto ctor = reinterpret_cast<CtorFn>(
      dlsym(h, "_ZN12AIDataParserC1Ev"));
  auto dtor = reinterpret_cast<DtorFn>(
      dlsym(h, "_ZN12AIDataParserD1Ev"));
  auto parse = reinterpret_cast<ParseFn>(dlsym(
      h, "_ZN12AIDataParser11parseAIDataEPhiP10BC_AI_DATAP12BC_FISH_INFOP18BC_TLV_COMMON_INFO"));
  if (!ctor || !dtor || !parse) {
    fprintf(stderr,
            "missing symbols: ctor=%p dtor=%p parse=%p (dlerror=%s)\n",
            (void*)ctor, (void*)dtor, (void*)parse, dlerror());
    return 1;
  }

  // 3) Read input bytes.
  std::vector<uint8_t> input;
  std::string arg = argv[2];
  if (arg.size() >= 1 && arg[0] == '@') {
    FILE* f = fopen(arg.c_str() + 1, "rb");
    if (!f) {
      fprintf(stderr, "cannot open: %s\n", arg.c_str() + 1);
      return 1;
    }
    uint8_t buf[8192];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
      input.insert(input.end(), buf, buf + n);
    fclose(f);
  } else {
    input = fromHex(arg);
  }

  fprintf(stderr, "[probe] read %zu bytes of input\n", input.size());

  // 4) Allocate + construct AIDataParser.
  auto* parser = static_cast<uint8_t*>(std::calloc(1, AI_DATA_PARSER_SIZE));
  if (!parser) {
    fprintf(stderr, "calloc failed\n");
    return 1;
  }
  ctor(parser);
  fprintf(stderr, "[probe] AIDataParser constructed at %p\n", parser);

  // 5) Allocate output structures.
  auto* aiData = static_cast<uint8_t*>(std::calloc(1, BC_AI_DATA_SIZE));
  // BC_FISH_INFO and BC_TLV_COMMON_INFO are smaller; over-allocate for safety.
  auto* fishInfo = static_cast<uint8_t*>(std::calloc(1, 256));
  auto* tlvInfo = static_cast<uint8_t*>(std::calloc(1, 256));

  // 6) Invoke parseAIData.
  int rv = parse(parser, input.data(), static_cast<int>(input.size()),
                 aiData, fishInfo, tlvInfo);
  fprintf(stderr, "[probe] parseAIData returned %d\n", rv);

  // 7) Print result as JSON.
  printf("{\n");
  printf("  \"return\": %d,\n", rv);
  printf("  \"input_size\": %zu,\n", input.size());
  printf("  \"views\": {\n");
  bc::dumpView("view0", aiData + 0x8);
  bc::dumpView("view1", aiData + 0x468);
  bc::dumpView("view2", aiData + 0x8c8);
  printf("  }\n");
  printf("}\n");

  // 8) Cleanup.
  dtor(parser);
  std::free(parser);
  std::free(aiData);
  std::free(fishInfo);
  std::free(tlvInfo);
  dlclose(h);
  return 0;
}

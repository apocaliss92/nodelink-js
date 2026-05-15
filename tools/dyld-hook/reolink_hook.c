// Reolink AI Mark inline-hook dylib.
//
// Loaded into Reolink.app via DYLD_INSERT_LIBRARIES, this:
//   1) Waits for libBCSDKWrapper.dylib to be loaded by dyld
//   2) Locates AIDataParser::parseAIData via dlsym
//   3) Inline-patches its prologue with an absolute JMP to our handler
//   4) Saves the overwritten bytes to a RWX trampoline so we can call the
//      original transparently
//
// Every call to parseAIData logs:
//   - timestamp (mach_absolute_time normalized to ms)
//   - input buffer hex (first 256 bytes)
//   - input buffer size
//   - return value
//   - any non-empty box arrays in the output BC_AI_DATA (3 views * 4 classes)
//
// Log written to /tmp/aimark-hook.log
//
// Build:
//   clang -arch x86_64 -shared -fPIC -O2 \
//       -framework CoreFoundation \
//       -o /tmp/reolink-hook.dylib reolink_hook.c
//
// Run:
//   DYLD_INSERT_LIBRARIES=/tmp/reolink-hook.dylib \
//       /Applications/Reolink.app/Contents/MacOS/Reolink &
//
// IMPORTANT: Reolink.app already grants `disable-library-validation` and
// `allow-dyld-environment-variables` so the dylib will load without re-signing.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>
#include <pthread.h>
#include <dlfcn.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <mach-o/dyld.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <mach/vm_map.h>

#define LOG_PATH "/tmp/aimark-hook.log"
#define SDK_BASENAME "libBCSDKWrapper.dylib"
#define PARSEAIDATA_SYM \
    "_ZN12AIDataParser11parseAIDataEPhiP10BC_AI_DATAP12BC_FISH_INFOP18BC_TLV_COMMON_INFO"

// 8-byte iframe prefix + 152-byte standard block = max ~264. Cap to be safe.
#define MAX_DUMP_BYTES 256

// BC_AI_DATA layout we reverse-engineered from parseAIData's coordinate-rotation
// pass (offsets in bytes, sizes in u16):
//   +0x008 .. +0x468 : view 0 (4 class arrays of 0x118 bytes)
//   +0x468 .. +0x8c8 : view 1
//   +0x8c8 .. +0xd28 : view 2
// Each class array:
//   +0x10 (u16): width
//   +0x12 (u16): height
//   +0x14 (u16): box count
//   +0x16 +    : array of 16-byte box records (x, y, w, h pairs + flags)
static const size_t VIEW_OFFSETS[3] = {0x8, 0x468, 0x8c8};
static const size_t CLASS_SIZE     = 0x118;
static const size_t BOX_RECORD_SIZE = 16;

// We overwrite the first 13 bytes of parseAIData (clean instruction boundary
// just after `push rbx` in the prologue) with a 12-byte absolute jump,
// padded with one NOP.
#define HOOK_PROLOGUE_LEN 13

typedef int (*parse_ai_data_fn)(void* /*this*/,
                                 uint8_t* /*buf*/, int /*size*/,
                                 void* /*BC_AI_DATA*/,
                                 void* /*BC_FISH_INFO*/,
                                 void* /*BC_TLV_COMMON_INFO*/);

static FILE* g_log = NULL;
static parse_ai_data_fn g_trampoline = NULL;
static parse_ai_data_fn g_original_addr = NULL;
static volatile int g_installed = 0;
static pthread_mutex_t g_log_mu = PTHREAD_MUTEX_INITIALIZER;

static double now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec * 1000.0 + tv.tv_usec / 1000.0;
}

static void log_hex(const uint8_t* buf, size_t n) {
    size_t cap = n < MAX_DUMP_BYTES ? n : MAX_DUMP_BYTES;
    for (size_t i = 0; i < cap; i++) fprintf(g_log, "%02x", buf[i]);
}

// Our handler that wraps the original parseAIData call.
static int hook_parseAIData(void* this_,
                            uint8_t* buf, int size,
                            void* bc_ai, void* bc_fish, void* bc_tlv) {
    pthread_mutex_lock(&g_log_mu);
    double t = now_ms();
    fprintf(g_log, "\n=== parseAIData @ %.3f ms ===\n", t);
    fprintf(g_log, "  this=%p buf=%p size=%d bc_ai=%p bc_fish=%p bc_tlv=%p\n",
            this_, buf, size, bc_ai, bc_fish, bc_tlv);
    if (buf && size > 0) {
        fprintf(g_log, "  input(%dB): ", size);
        log_hex(buf, (size_t)size);
        fprintf(g_log, "\n");
    }
    fflush(g_log);
    pthread_mutex_unlock(&g_log_mu);

    int rv = g_trampoline(this_, buf, size, bc_ai, bc_fish, bc_tlv);

    pthread_mutex_lock(&g_log_mu);
    fprintf(g_log, "  return=%d\n", rv);
    if (bc_ai) {
        const uint8_t* p = (const uint8_t*)bc_ai;
        int nonempty = 0;
        for (int v = 0; v < 3; v++) {
            const uint8_t* view = p + VIEW_OFFSETS[v];
            for (int c = 0; c < 4; c++) {
                const uint8_t* cls = view + c * CLASS_SIZE;
                uint16_t w   = *(const uint16_t*)(cls + 0x10);
                uint16_t h   = *(const uint16_t*)(cls + 0x12);
                uint16_t cnt = *(const uint16_t*)(cls + 0x14);
                if (cnt == 0) continue;
                if (cnt > 16) cnt = 16; // sanity cap
                nonempty++;
                fprintf(g_log, "  view%d class%d  %ux%u  boxes=%u: ",
                        v, c, w, h, cnt);
                for (int b = 0; b < cnt; b++) {
                    const uint16_t* box =
                        (const uint16_t*)(cls + 0x16 + b * BOX_RECORD_SIZE);
                    fprintf(g_log, "[%u,%u,%u,%u,%u,%u,%u,%u] ",
                            box[0], box[1], box[2], box[3],
                            box[4], box[5], box[6], box[7]);
                }
                fprintf(g_log, "\n");
            }
        }
        if (!nonempty) {
            fprintf(g_log, "  (no boxes in any view/class)\n");
        }
    }
    fflush(g_log);
    pthread_mutex_unlock(&g_log_mu);
    return rv;
}

// Make a code page writable (RWX) via mach_vm_protect.
static int make_writable(void* addr, size_t len) {
    mach_port_t task = mach_task_self();
    vm_address_t a = (vm_address_t)addr;
    vm_size_t   s = (vm_size_t)len;
    // Some macOS versions reject VM_PROT_ALL | COPY; try the simple form first.
    kern_return_t kr = mach_vm_protect(task, a, s, FALSE,
        VM_PROT_READ | VM_PROT_WRITE | VM_PROT_EXECUTE | VM_PROT_COPY);
    if (kr != KERN_SUCCESS) {
        kr = mach_vm_protect(task, a, s, FALSE,
            VM_PROT_READ | VM_PROT_WRITE | VM_PROT_EXECUTE);
    }
    return (kr == KERN_SUCCESS) ? 0 : -1;
}

static int make_executable(void* addr, size_t len) {
    mach_port_t task = mach_task_self();
    vm_address_t a = (vm_address_t)addr;
    vm_size_t   s = (vm_size_t)len;
    kern_return_t kr = mach_vm_protect(task, a, s, FALSE,
        VM_PROT_READ | VM_PROT_EXECUTE);
    return (kr == KERN_SUCCESS) ? 0 : -1;
}

// Write an absolute jump `mov rax, imm64; jmp rax` at `at` to `target`,
// padding with NOPs up to `len` total bytes.
//   48 B8 [8-byte target LE]   ; mov rax, imm64  (10 bytes)
//   FF E0                       ; jmp rax        (2 bytes)
//   90...                       ; nop padding
static void write_abs_jump(uint8_t* at, void* target, size_t len) {
    uint64_t addr = (uint64_t)target;
    at[0] = 0x48; at[1] = 0xB8;
    memcpy(at + 2, &addr, 8);
    at[10] = 0xFF; at[11] = 0xE0;
    for (size_t i = 12; i < len; i++) at[i] = 0x90;
}

static int install_hook(void* parseAIData_addr) {
    if (g_installed) return 0;

    // Allocate trampoline: copy of saved prologue bytes + JMP back to
    // parseAIData + HOOK_PROLOGUE_LEN.
    size_t tramp_len = HOOK_PROLOGUE_LEN + 12;  // 12 bytes for the jump back
    uint8_t* tramp = mmap(NULL, tramp_len,
                          PROT_READ | PROT_WRITE | PROT_EXEC,
                          MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (tramp == MAP_FAILED) {
        fprintf(g_log, "[hook] mmap failed: %s\n", strerror(errno));
        return -1;
    }
    memcpy(tramp, parseAIData_addr, HOOK_PROLOGUE_LEN);
    write_abs_jump(tramp + HOOK_PROLOGUE_LEN,
                   (uint8_t*)parseAIData_addr + HOOK_PROLOGUE_LEN,
                   12);

    // Make the target code writable, patch it, then restore execute perms.
    if (make_writable(parseAIData_addr, HOOK_PROLOGUE_LEN) != 0) {
        fprintf(g_log, "[hook] make_writable failed\n");
        return -1;
    }
    write_abs_jump((uint8_t*)parseAIData_addr, (void*)hook_parseAIData,
                   HOOK_PROLOGUE_LEN);
    // Some macOS versions don't actually need explicit re-protect, but doing
    // it keeps W^X invariant where the kernel enforces it.
    make_executable(parseAIData_addr, HOOK_PROLOGUE_LEN);

    g_trampoline = (parse_ai_data_fn)tramp;
    g_original_addr = (parse_ai_data_fn)parseAIData_addr;
    __sync_synchronize();
    g_installed = 1;

    fprintf(g_log, "[hook] installed: parseAIData=%p trampoline=%p\n",
            parseAIData_addr, tramp);
    fflush(g_log);
    return 0;
}

// Try to resolve the symbol from libBCSDKWrapper.dylib. Called whenever a
// new image is added by dyld.
static void try_install(void) {
    if (g_installed) return;

    // Iterate loaded images and find one whose basename matches SDK_BASENAME.
    uint32_t count = _dyld_image_count();
    for (uint32_t i = 0; i < count; i++) {
        const char* name = _dyld_get_image_name(i);
        if (!name) continue;
        const char* base = strrchr(name, '/');
        base = base ? base + 1 : name;
        if (strcmp(base, SDK_BASENAME) != 0) continue;

        // Load handle for dlsym. Use the absolute path to be deterministic.
        void* h = dlopen(name, RTLD_NOW | RTLD_NOLOAD);
        if (!h) {
            fprintf(g_log, "[hook] dlopen(%s) failed: %s\n", name, dlerror());
            continue;
        }
        void* sym = dlsym(h, PARSEAIDATA_SYM);
        if (!sym) {
            fprintf(g_log, "[hook] symbol not found in %s\n", base);
            dlclose(h);
            continue;
        }
        install_hook(sym);
        // Intentionally keep handle alive — don't dlclose.
        return;
    }
}

static void on_image_added(const struct mach_header* mh, intptr_t slide) {
    (void)mh; (void)slide;
    try_install();
}

__attribute__((constructor))
static void hook_ctor(void) {
    g_log = fopen(LOG_PATH, "w");
    if (!g_log) g_log = stderr;
    fprintf(g_log, "[hook] loaded, pid=%d\n", getpid());
    fprintf(g_log, "[hook] expecting %s with symbol %s\n",
            SDK_BASENAME, PARSEAIDATA_SYM);
    fflush(g_log);

    // First, scan the images currently loaded.
    try_install();
    if (g_installed) return;

    // If the SDK isn't loaded yet, register a callback. Returning here lets
    // the app run normally; the install will fire as soon as dyld maps
    // libBCSDKWrapper.dylib.
    _dyld_register_func_for_add_image(on_image_added);
    fprintf(g_log, "[hook] waiting for %s to be loaded...\n", SDK_BASENAME);
    fflush(g_log);
}

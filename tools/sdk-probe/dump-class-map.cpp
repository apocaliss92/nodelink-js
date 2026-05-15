// Dump the s_tlv_types_map (and s_tlv_types_map_2) static maps inside
// libBCSDKWrapper.dylib by walking the libc++ std::map<int, std::map<int,
// std::map<int, int>>> rb-tree directly in memory.
//
// The maps are populated at dylib load by C++ static initializers, so we
// dlopen the SDK and then read the well-known BSS addresses (from the symbol
// table: __ZL15s_tlv_types_map at virtual 0xf29728).
//
// libc++'s std::map layout (relevant parts):
//   class map {
//     __tree __tree_;
//   };
//   class __tree {
//     __iter_pointer __begin_node_;   // offset 0
//     __end_node    __pair1_.first_;  // offset 8 (left/right/parent)
//     size_type     __pair3_.first_;  // offset 32
//   };
//
//   class __tree_node_base {
//     __left_   ;  // offset 0
//     __right_  ;  // offset 8
//     __parent_ ;  // offset 16
//     bool __is_black_; // offset 24 (padded)
//   };
//
//   class __tree_node : public __tree_node_base {
//     value_type __value_;   // offset 32 (8-byte aligned)
//   };
//
// For std::map<int, ...> the value at offset 32 is std::pair<const int, V>:
//   - offset 32: int key (padded to 8)
//   - offset 40: V value (which is a nested std::map for the outer/middle maps,
//                 and an int action_code for the inner map)
//
// Build:
//   clang++ -arch x86_64 -std=c++17 -O0 -o dump-class-map dump-class-map.cpp
// Run:
//   ./dump-class-map /path/to/libBCSDKWrapper.dylib

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <string>
#include <vector>

constexpr uint64_t S_TLV_TYPES_MAP_VADDR   = 0xf29728;
constexpr uint64_t S_TLV_TYPES_MAP_2_VADDR = 0xf29740;

struct Node {
  Node*    left_;     // +0
  Node*    right_;    // +8
  uint64_t parent_;   // +16
  uint8_t  is_black_; // +24 (padded)
  // +32: key (int) padded to 8
  // +40: value (Node* for nested map, or int for leaf)
};

// Node layout differs by level (verified from __analysisExtenTLV disassembly):
//
//  OUTER + MIDDLE maps  std::map<int, nested_map*>  (key+value 8-byte aligned)
//     +0x00 left, +0x08 right, +0x10 parent
//     +0x18 1B color + 7B padding
//     +0x20 int key + 4B padding
//     +0x30 nested map pointer
//
//  INNER map  std::map<int, int>  (4-byte aligned int pair)
//     +0x00 left, +0x08 right, +0x10 parent
//     +0x18 1B color + 3B padding
//     +0x1c int key
//     +0x20 int action_code
//
// We pass `is_leaf` so the same Node* can be re-interpreted at either layout.
static int  read_key_outer(const Node* n)  { return *reinterpret_cast<const int*>(reinterpret_cast<const uint8_t*>(n) + 0x20); }
static int  read_key_inner(const Node* n)  { return *reinterpret_cast<const int*>(reinterpret_cast<const uint8_t*>(n) + 0x1c); }
static Node*read_value_node(const Node* n) { return *reinterpret_cast<Node* const*>(reinterpret_cast<const uint8_t*>(n) + 0x30); }
static int  read_value_int(const Node* n)  { return *reinterpret_cast<const int*>(reinterpret_cast<const uint8_t*>(n) + 0x20); }

// In libc++ the std::map struct itself is a __tree which holds __end_node_
// inside __pair1_ at offset 8. The root of the RB tree is __end_node_.__left_.
//   layout:
//     +0   __begin_node_  (pointer to leftmost real node)
//     +8   __end_node_    (an empty sentinel; its __left_ is the root)
// Reading the root: *reinterpret_cast<Node**>(map_addr + 8 + 0)
//   (i.e. __end_node_.__left_)
static Node* root_of(void* map_addr) {
  uint8_t* p = static_cast<uint8_t*>(map_addr);
  Node** end_left = reinterpret_cast<Node**>(p + 8);
  return *end_left;
}

// In-order traversal: yields nodes in key-sorted order.
template <class Visit>
static void inorder(Node* n, Visit visit) {
  if (!n) return;
  // libc++ uses Node*+1 sentinel sometimes; null check is enough here.
  inorder(n->left_, visit);
  visit(n);
  inorder(n->right_, visit);
}

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s <libBCSDKWrapper.dylib>\n", argv[0]);
    return 2;
  }

  void* h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!h) {
    std::fprintf(stderr, "dlopen failed: %s\n", dlerror());
    return 1;
  }

  // Find the slid base address of the dylib via _dyld_image_count() iteration.
  uint64_t slide = 0;
  bool found = false;
  uint32_t n = _dyld_image_count();
  for (uint32_t i = 0; i < n; i++) {
    const char* name = _dyld_get_image_name(i);
    if (name && std::string(name).find("BCSDKWrapper") != std::string::npos) {
      slide = static_cast<uint64_t>(_dyld_get_image_vmaddr_slide(i));
      std::fprintf(stderr, "[dump] %s slide=0x%llx\n", name, slide);
      found = true;
      break;
    }
  }
  if (!found) {
    std::fprintf(stderr, "[dump] BCSDKWrapper image not found\n");
    return 1;
  }

  for (auto& [vaddr, name] : std::vector<std::pair<uint64_t, const char*>>{
           {S_TLV_TYPES_MAP_VADDR, "s_tlv_types_map"},
           {S_TLV_TYPES_MAP_2_VADDR, "s_tlv_types_map_2"},
       }) {
    void* map_addr = reinterpret_cast<void*>(vaddr + slide);
    std::fprintf(stderr, "\n[dump] %s @ %p\n", name, map_addr);
    // First dump the raw 24 bytes of the std::map struct itself so we can
    // see its layout (begin_node, end_node fields).
    uint8_t* m = static_cast<uint8_t*>(map_addr);
    std::fprintf(stderr, "[dump] map raw bytes:");
    for (int i = 0; i < 24; i++) std::fprintf(stderr, " %02x", m[i]);
    std::fprintf(stderr, "\n");
    Node* root = root_of(map_addr);
    std::fprintf(stderr, "[dump] root=%p\n", root);
    if (root) {
      // Dump the root node's first 56 bytes so we can verify layout assumptions.
      uint8_t* r = reinterpret_cast<uint8_t*>(root);
      std::fprintf(stderr, "[dump] root node first 56 bytes:");
      for (int i = 0; i < 56; i++) std::fprintf(stderr, " %02x", r[i]);
      std::fprintf(stderr, "\n");
    }
    if (!root) continue;

    std::printf("# %s\n", name);
    std::printf("type1\ttype2\ttype3\taction_code\n");
    inorder(root, [&](Node* n1) {
      int t1 = read_key_outer(n1);
      Node* m2 = read_value_node(n1);
      if (!m2) {
        std::printf("%d\t-\t-\tnull\n", t1);
        return;
      }
      Node* r2 = root_of(m2);
      inorder(r2, [&](Node* n2) {
        int t2 = read_key_outer(n2);
        Node* m3 = read_value_node(n2);
        if (!m3) {
          std::printf("%d\t%d\t-\tnull\n", t1, t2);
          return;
        }
        Node* r3 = root_of(m3);
        inorder(r3, [&](Node* n3) {
          int t3 = read_key_inner(n3);
          int action = read_value_int(n3);
          std::printf("%d\t%d\t%d\t%d\n", t1, t2, t3, action);
        });
      });
    });
  }

  return 0;
}

/*
 * snapshot.h — the seam.
 *
 * One plain-data struct describing everything the visualizer knows about the
 * core at a point in time, plus a JSON serializer. This is the *only* contract
 * between the simulation and anything above it (docs/design.md §5): the native
 * CLI, the Node CLI and the browser all consume the exact same bytes, so UI
 * logic can be developed and tested against a recorded trace with no WASM and
 * no browser in the loop.
 *
 * Deliberately free of Verilator types — nothing here includes a generated
 * header, so this file and its tests build standalone.
 *
 * Timing convention. A snapshot taken after N clock steps has `cycle == N` and
 * describes the machine as it stands *between* posedges: `regs` hold everything
 * committed by the N posedges so far, while the stage fields describe the
 * instructions currently occupying F / X / M — i.e. what the machine is doing
 * now, not what it did. A register write committed at posedge N is reported
 * with `lastWriteCycle == N`, the same cycle its new value first appears in
 * `regs[rd].value`, so a highlight and the value it explains never disagree.
 */
#pragma once

#include <cstdint>
#include <string>

namespace hz3 {

// ---------------------------------------------------------------------------
// Encodings mirrored from the RTL. Bit positions must match hz3_probe.vh.

// Which source the operand mux in X selected. See p_x_bypass_a/b.
enum Bypass : uint8_t {
	BYPASS_NONE    = 0, // instruction has no register operand in this slot
	BYPASS_REGFILE = 1, // ordinary register read
	BYPASS_M       = 2, // forwarded from the X|M register (xm_result)
	BYPASS_W       = 3, // forwarded from the M|W register (mw_result)
};

// Bitmap of the reasons X is stalled; several can be true at once.
enum StallCause : uint8_t {
	STALL_M_STALL  = 1u << 0, // downstream: M cannot accept
	STALL_RAW      = 1u << 1, // load-use / read-after-write interlock
	STALL_MULDIV   = 1u << 2, // sequential multiply/divide in progress
	STALL_FENCE    = 1u << 3, // fence waiting for the memory system
	STALL_BUS_APH  = 1u << 4, // load/store address phase not accepted
	STALL_JUMP     = 1u << 5, // front end will not accept the jump
	STALL_STARVED  = 1u << 6, // no instruction available to execute
};

// Hazard3 memory-op encoding (hazard3_ops.vh). MEMOP_NONE means "not a
// load or store", which is how M distinguishes a data phase from a bubble.
enum MemOp : uint8_t {
	MEMOP_LW = 0x00, MEMOP_LH = 0x01, MEMOP_LB = 0x02,
	MEMOP_LHU = 0x03, MEMOP_LBU = 0x04,
	MEMOP_SW = 0x05, MEMOP_SH = 0x06, MEMOP_SB = 0x07,
	MEMOP_NONE = 0x10,
};

constexpr int64_t NEVER = -1; // "no such cycle yet", for lastWrite/lastRead

// ---------------------------------------------------------------------------
// Stage views

struct StageF {
	uint32_t pc = 0;          // address the front end is fetching
	uint32_t cir = 0;         // F|X pipeline register: the instruction word
	uint8_t  cirVld = 0;      // valid halfwords in the CIR
	bool     is32bit = false;
	bool     jumpReq = false; // front end being redirected this cycle
	bool     jumpRdy = false;
	uint32_t jumpTarget = 0;
};

struct StageX {
	uint32_t pc = 0;
	uint32_t instr = 0;
	bool     valid = false;   // an instruction is present (front end not starved)
	bool     issue = false;   // ...and it advances to M at this posedge
	uint8_t  rs1 = 0, rs2 = 0, rd = 0;
	uint32_t imm = 0;
	uint8_t  aluOp = 0, memOp = MEMOP_NONE, mulOp = 0, branchCond = 0;
	uint32_t opA = 0, opB = 0;      // post-bypass ALU inputs
	uint32_t aluResult = 0;
	uint32_t rs1Bypass = 0, rs2Bypass = 0;
	uint8_t  bypassA = BYPASS_NONE; // Bypass
	uint8_t  bypassB = BYPASS_NONE;
	bool     jumpReq = false;
	bool     stall = false;
	uint8_t  stallCause = 0;        // StallCause bitmap
	bool     starved = false;
	bool     csrRen = false, csrWen = false;
	uint32_t csrRdata = 0;
	uint8_t  except = 0;
};

struct StageM {
	bool     valid = false;   // M holds a real instruction, not a bubble
	uint32_t pc = 0;
	uint32_t instr = 0;
	uint8_t  rd = 0;
	uint32_t result = 0;      // writeback data (load data or ALU result)
	uint32_t xmResult = 0;    // the X|M latched ALU result
	uint8_t  memOp = MEMOP_NONE;
	bool     stall = false, busStall = false, dphaseInFlight = false;
	bool     regWen = false;  // a register write commits at this posedge
	bool     trapEnter = false, trapIsIrq = false;
	uint32_t trapAddr = 0;
	uint8_t  except = 0;
};

// ---------------------------------------------------------------------------
// Register activity
//
// `writes` and `lastWriteCycle` come from the core's write strobe, never from
// comparing values: a store of a value equal to the one already in the register
// is a real architectural write and must still be visible to the UI. See
// tracker.h.

struct RegView {
	uint32_t value = 0;
	uint64_t writes = 0;               // monotonic count of architectural writes
	int64_t  lastWriteCycle = NEVER;
	int64_t  lastReadCycle = NEVER;
};

struct CsrView {
	uint32_t mcycle = 0, minstret = 0, mepc = 0, mtvec = 0;
	uint32_t mcause = 0, mstatus = 0;
};

struct BusView {
	// The core's two internal request streams, before the single-port arbiter.
	bool     iReq = false;
	uint32_t iAddr = 0;
	bool     iDphReady = false;
	bool     dReq = false;
	uint32_t dAddr = 0;
	bool     dWrite = false;
	uint32_t dWdata = 0, dRdata = 0;
	bool     dDphReady = false;
	// The muxed AHB5 port as the SoC sees it.
	uint32_t haddr = 0;
	uint8_t  htrans = 0;
	bool     hwrite = false;
	uint8_t  hsize = 0;
};

struct Snapshot {
	uint64_t cycle = 0;
	uint64_t retired = 0;     // instructions issued from X (the core's own count)
	bool     exited = false;
	uint32_t exitCode = 0;
	StageF   f;
	StageX   x;
	StageM   m;
	RegView  regs[32];
	CsrView  csr;
	BusView  bus;
};

// ---------------------------------------------------------------------------
// Naming
//
// The RTL's raw encodings are named on the UI side (js/src/decode.mjs) so the
// tables live next to the code that draws them. The one exception is the stall
// reason: the native trace has to be legible on its own, and having C++ name it
// gives the JS table something to be checked against (see js/test/run.mjs).

inline const char *stallReasonName(uint8_t cause) {
	if (!cause)                    return "none";
	if (cause & STALL_RAW)         return "load-use";
	if (cause & STALL_MULDIV)      return "muldiv";
	if (cause & STALL_BUS_APH)     return "bus-address-phase";
	if (cause & STALL_FENCE)       return "fence";
	if (cause & STALL_JUMP)        return "jump-not-ready";
	if (cause & STALL_M_STALL)     return "downstream-m";
	if (cause & STALL_STARVED)     return "starved";
	return "unknown";
}

// ---------------------------------------------------------------------------
// JSON
//
// Hand-rolled so the simulator has no dependencies and the WASM build stays
// small. One line per snapshot, which makes a trace a JSONL file that any of
// the CLIs can stream.

namespace detail {

inline void key(std::string &o, const char *k, bool first = false) {
	if (!first) o += ',';
	o += '"'; o += k; o += "\":";
}

inline void num(std::string &o, uint64_t v) { o += std::to_string(v); }
inline void num(std::string &o, int64_t v)  { o += std::to_string(v); }
inline void boolean(std::string &o, bool v) { o += v ? "true" : "false"; }

inline void str(std::string &o, const char *v) { o += '"'; o += v; o += '"'; }

inline void u32(std::string &o, const char *k, uint32_t v, bool first = false) {
	key(o, k, first); num(o, (uint64_t)v);
}
inline void u64(std::string &o, const char *k, uint64_t v, bool first = false) {
	key(o, k, first); num(o, v);
}
inline void i64(std::string &o, const char *k, int64_t v, bool first = false) {
	key(o, k, first); num(o, v);
}
inline void flag(std::string &o, const char *k, bool v, bool first = false) {
	key(o, k, first); boolean(o, v);
}
inline void text(std::string &o, const char *k, const char *v, bool first = false) {
	key(o, k, first); str(o, v);
}

} // namespace detail

inline void toJson(const Snapshot &s, std::string &o) {
	using namespace detail;
	o += '{';
	u64(o, "cycle", s.cycle, true);
	u64(o, "retired", s.retired);
	flag(o, "exited", s.exited);
	u32(o, "exitCode", s.exitCode);

	key(o, "f"); o += '{';
	u32(o, "pc", s.f.pc, true);
	u32(o, "cir", s.f.cir);
	u32(o, "cirVld", s.f.cirVld);
	flag(o, "is32bit", s.f.is32bit);
	flag(o, "jumpReq", s.f.jumpReq);
	flag(o, "jumpRdy", s.f.jumpRdy);
	u32(o, "jumpTarget", s.f.jumpTarget);
	o += '}';

	key(o, "x"); o += '{';
	u32(o, "pc", s.x.pc, true);
	u32(o, "instr", s.x.instr);
	flag(o, "valid", s.x.valid);
	flag(o, "issue", s.x.issue);
	u32(o, "rs1", s.x.rs1);
	u32(o, "rs2", s.x.rs2);
	u32(o, "rd", s.x.rd);
	u32(o, "imm", s.x.imm);
	u32(o, "aluOp", s.x.aluOp);
	u32(o, "memOp", s.x.memOp);
	u32(o, "mulOp", s.x.mulOp);
	u32(o, "branchCond", s.x.branchCond);
	u32(o, "opA", s.x.opA);
	u32(o, "opB", s.x.opB);
	u32(o, "aluResult", s.x.aluResult);
	u32(o, "rs1Bypass", s.x.rs1Bypass);
	u32(o, "rs2Bypass", s.x.rs2Bypass);
	u32(o, "bypassA", s.x.bypassA);
	u32(o, "bypassB", s.x.bypassB);
	flag(o, "jumpReq", s.x.jumpReq);
	flag(o, "stall", s.x.stall);
	u32(o, "stallCause", s.x.stallCause);
	text(o, "stallReason", stallReasonName(s.x.stallCause));
	flag(o, "starved", s.x.starved);
	flag(o, "csrRen", s.x.csrRen);
	flag(o, "csrWen", s.x.csrWen);
	u32(o, "csrRdata", s.x.csrRdata);
	u32(o, "except", s.x.except);
	o += '}';

	key(o, "m"); o += '{';
	flag(o, "valid", s.m.valid, true);
	u32(o, "pc", s.m.pc);
	u32(o, "instr", s.m.instr);
	u32(o, "rd", s.m.rd);
	u32(o, "result", s.m.result);
	u32(o, "xmResult", s.m.xmResult);
	u32(o, "memOp", s.m.memOp);
	flag(o, "stall", s.m.stall);
	flag(o, "busStall", s.m.busStall);
	flag(o, "dphaseInFlight", s.m.dphaseInFlight);
	flag(o, "regWen", s.m.regWen);
	flag(o, "trapEnter", s.m.trapEnter);
	flag(o, "trapIsIrq", s.m.trapIsIrq);
	u32(o, "trapAddr", s.m.trapAddr);
	u32(o, "except", s.m.except);
	o += '}';

	key(o, "regs"); o += '[';
	for (int i = 0; i < 32; ++i) {
		if (i) o += ',';
		o += '{';
		u32(o, "value", s.regs[i].value, true);
		u64(o, "writes", s.regs[i].writes);
		i64(o, "lastWriteCycle", s.regs[i].lastWriteCycle);
		i64(o, "lastReadCycle", s.regs[i].lastReadCycle);
		o += '}';
	}
	o += ']';

	key(o, "csr"); o += '{';
	u32(o, "mcycle", s.csr.mcycle, true);
	u32(o, "minstret", s.csr.minstret);
	u32(o, "mepc", s.csr.mepc);
	u32(o, "mtvec", s.csr.mtvec);
	u32(o, "mcause", s.csr.mcause);
	u32(o, "mstatus", s.csr.mstatus);
	o += '}';

	key(o, "bus"); o += '{';
	flag(o, "iReq", s.bus.iReq, true);
	u32(o, "iAddr", s.bus.iAddr);
	flag(o, "iDphReady", s.bus.iDphReady);
	flag(o, "dReq", s.bus.dReq);
	u32(o, "dAddr", s.bus.dAddr);
	flag(o, "dWrite", s.bus.dWrite);
	u32(o, "dWdata", s.bus.dWdata);
	u32(o, "dRdata", s.bus.dRdata);
	flag(o, "dDphReady", s.bus.dDphReady);
	u32(o, "haddr", s.bus.haddr);
	u32(o, "htrans", s.bus.htrans);
	flag(o, "hwrite", s.bus.hwrite);
	u32(o, "hsize", s.bus.hsize);
	o += '}';

	o += '}';
}

inline std::string toJson(const Snapshot &s) {
	std::string o;
	o.reserve(4096);
	toJson(s, o);
	return o;
}

} // namespace hz3

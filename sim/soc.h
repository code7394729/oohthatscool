/*
 * soc.h — the tiny SoC that wraps the Verilated Hazard3 core.
 *
 * Owns the core model, a flat RAM, and a small MMIO block, and knows how to
 * service the single AHB5 master port. This is "Layer A" of the design
 * (docs/design.md): it is deliberately UI-agnostic and toolchain-agnostic, so
 * the same class backs the native CLI harness (sim/main.cpp), the native test
 * runner (sim/tests/), and the Embind bridge (sim/bridge.cpp).
 *
 * AHB timing note: the address phase of a transfer is presented in cycle N and
 * its data phase is serviced in cycle N+1. We therefore carry the captured
 * address phase across a step and answer it on the following one, mirroring
 * Hazard3's own testbench (test/sim/tb_verilator/tb.cpp).
 *
 * Observation point. step() ends with the clock low and combinational logic
 * settled, so at every point a caller can look, the model presents one whole,
 * consistent cycle: registers hold what the last posedge committed, and the
 * stage signals describe the instructions in flight right now. See
 * snapshot.h for what that means for the numbers the UI draws.
 */
#pragma once

#include "Vhz3_top.h"
#include "verilated.h"

#include "snapshot.h"
#include "tracker.h"
#include "vl_hooks.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

class Soc {
public:
	static constexpr uint32_t MEM_BASE = 0x80000000u;
	static constexpr uint32_t MEM_SIZE = 16u * 1024 * 1024; // 16 MiB
	static constexpr uint32_t IO_BASE  = 0xC0000000u;
	enum { IO_PRINT_CHAR = 0x00, IO_PRINT_U32 = 0x04, IO_EXIT = 0x08 };

	// Why a run stopped, so the UI can say so rather than guess.
	enum class StopReason { Cycles, Exit, Breakpoint, Retired, Fault };

	static const char *stopReasonName(StopReason r) {
		switch (r) {
		case StopReason::Cycles:     return "cycles";
		case StopReason::Exit:       return "exit";
		case StopReason::Breakpoint: return "breakpoint";
		case StopReason::Retired:    return "retired";
		case StopReason::Fault:      return "fault";
		}
		return "unknown";
	}

	struct RunResult {
		StopReason reason = StopReason::Cycles;
		uint64_t   cycles = 0;   // cycles executed by this call
		uint64_t   retired = 0;  // instructions retired by this call
	};

	Soc() : top(new Vhz3_top), mem(MEM_SIZE, 0) { hard_reset(); }
	~Soc() { delete top; }

	Soc(const Soc &) = delete;
	Soc &operator=(const Soc &) = delete;

	// ---- program loading --------------------------------------------------

	// Copy a flat binary image into RAM at `addr` (defaults to the reset region).
	void load_bin(const uint8_t *data, size_t len, uint32_t addr = MEM_BASE) {
		uint32_t off = addr - MEM_BASE;
		for (size_t i = 0; i < len && off + i < MEM_SIZE; ++i)
			mem[off + i] = data[i];
	}

	bool load_file(const std::string &path) {
		FILE *f = fopen(path.c_str(), "rb");
		if (!f) return false;
		fseek(f, 0, SEEK_END);
		long n = ftell(f);
		fseek(f, 0, SEEK_SET);
		if (n < 0) { fclose(f); return false; }
		std::vector<uint8_t> buf((size_t)n);
		size_t got = fread(buf.data(), 1, (size_t)n, f);
		fclose(f);
		load_bin(buf.data(), got);
		return true;
	}

	uint32_t read_mem(uint32_t addr) const { return bus_read(addr); }

	void write_mem(uint32_t addr, uint32_t data) {
		if (addr >= MEM_BASE && addr < MEM_BASE + MEM_SIZE) {
			uint32_t a = addr - MEM_BASE;
			for (unsigned i = 0; i < 4; ++i)
				mem[a + i] = (data >> (8 * i)) & 0xffu;
		}
	}

	// ---- clocking ---------------------------------------------------------

	// Assert reset, tick a few clocks, deassert. Program memory is preserved,
	// so a caller can reset and re-run without reloading.
	void hard_reset() {
		exited = false; exit_code = 0; cycles = 0; retired = 0;
		regs.reset();
		output.clear();
		hz3::clear_fault();
		aphase_vld = false; aphase_addr = 0; aphase_write = false; aphase_size = 0;
		top->hready = 1; top->hresp = 0; top->hexokay = 1; top->hrdata = 0;
		top->rst_n = 0; top->clk = 0; top->eval();
		for (int i = 0; i < 4; ++i) { top->clk = 0; top->eval(); top->clk = 1; top->eval(); }
		top->rst_n = 1; top->clk = 0; top->eval();
		capture_address_phase();
	}

	// Advance exactly one clock cycle and service the AHB port.
	void step() {
		// The model is settled with the clock low, so these are the values the
		// core is presenting *into* the coming posedge: the register write that
		// is about to commit, and whether an instruction issues from X. Sampling
		// them here is what lets a write be attributed to the same cycle in
		// which its result becomes visible in the register file.
		const bool     wr_en    = top->p_m_reg_wen != 0;
		const unsigned wr_rd    = top->p_m_rd;
		const uint32_t wr_data  = top->p_m_result;
		const bool     retiring = top->p_instr_ret != 0;

		top->clk = 1; top->eval();      // rising edge: state advances
		++cycles;

		if (retiring) ++retired;
		if (wr_en) regs.noteWrite(wr_rd, wr_data, cycles);

		// Service the data phase of the transfer whose address we captured last
		// cycle. hready is held high (zero-wait-state memory).
		if (aphase_vld) {
			if (aphase_write)
				bus_write(aphase_addr, top->hwdata, aphase_size);
			else
				top->hrdata = bus_read(aphase_addr);
		}
		top->hready = 1; top->hexokay = 1; top->hresp = 0;

		// Settle the combinational logic for the cycle we are now in, with the
		// bus response applied, then capture the address phase it presents.
		top->clk = 0; top->eval();
		capture_address_phase();

		// Register reads are attributed to the cycle in which X is consuming
		// them. A stalled instruction re-reads its operands every cycle it sits
		// in X, which is exactly what the hardware does.
		if (top->p_x_valid) {
			regs.noteRead(top->p_x_rs1, cycles);
			regs.noteRead(top->p_x_rs2, cycles);
		}
	}

	// Run until the program exits, a breakpoint hits, or the budget runs out.
	// `break_pc` is matched against the PC of the instruction in X; pass
	// NO_BREAK to disable.
	static constexpr uint32_t NO_BREAK = 0xffffffffu;

	RunResult run(uint64_t max_cycles, uint32_t break_pc = NO_BREAK) {
		const uint64_t c0 = cycles, r0 = retired;
		RunResult res;
		for (uint64_t i = 0; i < max_cycles; ++i) {
			step();
			if (hz3::fault().active()) { res.reason = StopReason::Fault; break; }
			if (exited) { res.reason = StopReason::Exit; break; }
			if (break_pc != NO_BREAK && top->p_x_valid && top->p_x_pc == break_pc) {
				res.reason = StopReason::Breakpoint;
				break;
			}
		}
		res.cycles = cycles - c0;
		res.retired = retired - r0;
		return res;
	}

	// Advance until one more instruction has issued from X, which is Hazard3's
	// own definition of retirement (it is what increments minstret).
	RunResult step_instruction(uint64_t max_cycles = 10000) {
		const uint64_t c0 = cycles, r0 = retired;
		RunResult res;
		for (uint64_t i = 0; i < max_cycles; ++i) {
			step();
			if (hz3::fault().active()) { res.reason = StopReason::Fault; break; }
			if (exited)                { res.reason = StopReason::Exit; break; }
			if (retired != r0)         { res.reason = StopReason::Retired; break; }
		}
		res.cycles = cycles - c0;
		res.retired = retired - r0;
		return res;
	}

	// ---- state out --------------------------------------------------------

	hz3::Snapshot snapshot() const {
		hz3::Snapshot s;
		s.cycle    = cycles;
		s.retired  = retired;
		s.exited   = exited;
		s.exitCode = exit_code;

		s.f.pc         = top->p_f_pc;
		s.f.cir        = top->p_f_cir;
		s.f.cirVld     = top->p_f_cir_vld;
		s.f.is32bit    = top->p_f_cir_is_32bit;
		s.f.jumpReq    = top->p_f_jump_req;
		s.f.jumpRdy    = top->p_f_jump_rdy;
		s.f.jumpTarget = top->p_f_jump_target;

		s.x.pc         = top->p_x_pc;
		s.x.instr      = top->p_f_cir;   // the CIR *is* the F|X pipeline register
		s.x.valid      = top->p_x_valid;
		s.x.issue      = top->p_x_issue;
		s.x.rs1        = top->p_x_rs1;
		s.x.rs2        = top->p_x_rs2;
		s.x.rd         = top->p_x_rd;
		s.x.imm        = top->p_x_imm;
		s.x.aluOp      = top->p_x_aluop;
		s.x.memOp      = top->p_x_memop;
		s.x.mulOp      = top->p_x_mulop;
		s.x.branchCond = top->p_x_branchcond;
		s.x.opA        = top->p_x_op_a;
		s.x.opB        = top->p_x_op_b;
		s.x.aluResult  = top->p_x_alu_result;
		s.x.rs1Bypass  = top->p_x_rs1_bypass;
		s.x.rs2Bypass  = top->p_x_rs2_bypass;
		s.x.bypassA    = top->p_x_bypass_a;
		s.x.bypassB    = top->p_x_bypass_b;
		s.x.jumpReq    = top->p_x_jump_req;
		s.x.stall      = top->p_x_stall;
		s.x.stallCause = top->p_x_stall_cause;
		s.x.starved    = top->p_x_starved;
		s.x.csrRen     = top->p_x_csr_ren;
		s.x.csrWen     = top->p_x_csr_wen;
		s.x.csrRdata   = top->p_x_csr_rdata;
		s.x.except     = top->p_x_except;

		s.m.valid          = top->p_m_valid;
		s.m.pc             = top->p_m_pc;
		s.m.instr          = top->p_m_instr;
		s.m.rd             = top->p_m_rd;
		s.m.result         = top->p_m_result;
		s.m.xmResult       = top->p_m_xm_result;
		s.m.memOp          = top->p_m_memop;
		s.m.stall          = top->p_m_stall;
		s.m.busStall       = top->p_m_bus_stall;
		s.m.dphaseInFlight = top->p_m_dphase_in_flight;
		s.m.regWen         = top->p_m_reg_wen;
		s.m.trapEnter      = top->p_m_trap_enter_vld;
		s.m.trapIsIrq      = top->p_m_trap_is_irq;
		s.m.trapAddr       = top->p_m_trap_addr;
		s.m.except         = top->p_m_except;

		// p_regs is a flat 1024-bit port, one 32-bit word per register, so the
		// generated VlWide indexes straight through.
		uint32_t values[32];
		for (int i = 0; i < 32; ++i)
			values[i] = top->p_regs[i];
		regs.fill(s.regs, values);

		s.csr.mcycle   = top->p_csr_mcycle;
		s.csr.minstret = top->p_csr_minstret;
		s.csr.mepc     = top->p_csr_mepc;
		s.csr.mtvec    = top->p_csr_mtvec;
		s.csr.mcause   = top->p_csr_mcause;
		s.csr.mstatus  = top->p_csr_mstatus;

		s.bus.iReq      = top->p_bus_i_aph_req;
		s.bus.iAddr     = top->p_bus_i_addr;
		s.bus.iDphReady = top->p_bus_i_dph_ready;
		s.bus.dReq      = top->p_bus_d_aph_req;
		s.bus.dAddr     = top->p_bus_d_addr;
		s.bus.dWrite    = top->p_bus_d_write;
		s.bus.dWdata    = top->p_bus_d_wdata;
		s.bus.dRdata    = top->p_bus_d_rdata;
		s.bus.dDphReady = top->p_bus_d_dph_ready;
		s.bus.haddr     = top->haddr;
		s.bus.htrans    = top->htrans;
		s.bus.hwrite    = top->hwrite;
		s.bus.hsize     = top->hsize;

		return s;
	}

	std::string snapshot_json() const { return hz3::toJson(snapshot()); }

	// ---- program output ---------------------------------------------------
	//
	// MMIO character writes are appended here as well as echoed to stdout, so a
	// hosted caller (the browser, or a test) can read them back without a
	// filesystem or a captured stream.

	void set_echo(bool on) { echo = on; }
	const std::string &take_output() const { return output; }
	void clear_output() { output.clear(); }

	// Read and clear, for hosts that poll (the browser, the Node CLI).
	std::string drain_output() {
		std::string s;
		s.swap(output);
		return s;
	}

	bool     exited = false;
	uint32_t exit_code = 0;
	uint64_t cycles = 0;
	uint64_t retired = 0;

	const hz3::RegTracker &tracker() const { return regs; }

private:
	Vhz3_top *top;
	std::vector<uint8_t> mem;
	hz3::RegTracker regs;
	std::string output;
	bool echo = true;

	bool     aphase_vld = false;
	uint32_t aphase_addr = 0;
	bool     aphase_write = false;
	uint32_t aphase_size = 0;

	// htrans[1] distinguishes NONSEQ/SEQ (an active transfer) from IDLE/BUSY.
	void capture_address_phase() {
		aphase_vld   = ((top->htrans >> 1) & 1) != 0;
		aphase_addr  = top->haddr;
		aphase_write = top->hwrite != 0;
		aphase_size  = top->hsize;
	}

	uint32_t bus_read(uint32_t addr) const {
		if (addr >= MEM_BASE && addr < MEM_BASE + MEM_SIZE) {
			uint32_t a = (addr - MEM_BASE) & ~3u;
			return (uint32_t)mem[a] | (uint32_t)mem[a + 1] << 8 |
			       (uint32_t)mem[a + 2] << 16 | (uint32_t)mem[a + 3] << 24;
		}
		return 0; // reads of the MMIO block return 0 for now
	}

	// Hazard3 replicates store data across all byte lanes, so a sub-word store
	// can be taken from the low lanes (this mirrors the reference testbench).
	void bus_write(uint32_t addr, uint32_t wdata, uint32_t size) {
		if (addr >= MEM_BASE && addr < MEM_BASE + MEM_SIZE) {
			uint32_t a = addr - MEM_BASE;
			unsigned n = 1u << size;
			for (unsigned i = 0; i < n; ++i)
				mem[a + i] = (wdata >> (8 * i)) & 0xffu;
		} else if (addr == IO_BASE + IO_PRINT_CHAR) {
			output.push_back((char)(wdata & 0xff));
			if (echo) fputc((int)(wdata & 0xff), stdout);
		} else if (addr == IO_BASE + IO_PRINT_U32) {
			char buf[16];
			snprintf(buf, sizeof buf, "%08x\n", wdata);
			output += buf;
			if (echo) fputs(buf, stdout);
		} else if (addr == IO_BASE + IO_EXIT) {
			if (!exited) { exited = true; exit_code = wdata; }
		}
	}
};

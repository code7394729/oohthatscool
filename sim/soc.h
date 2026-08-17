/*
 * soc.h — the tiny SoC that wraps the Verilated Hazard3 core.
 *
 * Owns the core model, a flat RAM, and a small MMIO block, and knows how to
 * service the single AHB5 master port. This is "Layer A" of the design
 * (docs/design.md): it is deliberately UI-agnostic and toolchain-agnostic, so
 * the same class backs both the native CLI harness (sim/main.cpp) and, later,
 * the Emscripten/Embind bridge.
 *
 * AHB timing note: the address phase of a transfer is presented in cycle N and
 * its data phase is serviced in cycle N+1. We therefore carry the captured
 * address phase across a step and answer it on the following one, mirroring
 * Hazard3's own testbench (test/sim/tb_verilator/tb.cpp).
 */
#pragma once

#include "Vhz3_top.h"
#include "verilated.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include <string>

class Soc {
public:
	static constexpr uint32_t MEM_BASE = 0x80000000u;
	static constexpr uint32_t MEM_SIZE = 16u * 1024 * 1024; // 16 MiB
	static constexpr uint32_t IO_BASE  = 0xC0000000u;
	enum { IO_PRINT_CHAR = 0x00, IO_PRINT_U32 = 0x04, IO_EXIT = 0x08 };

	Soc() : top(new Vhz3_top), mem(MEM_SIZE, 0) { hard_reset(); }
	~Soc() { delete top; }

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

	// Assert reset, tick a few clocks, deassert. Program memory is preserved.
	void hard_reset() {
		exited = false; exit_code = 0; cycles = 0;
		aphase_vld = false; aphase_addr = 0; aphase_write = false; aphase_size = 0;
		top->hready = 1; top->hresp = 0; top->hexokay = 1; top->hrdata = 0;
		top->rst_n = 0; top->clk = 0; top->eval();
		for (int i = 0; i < 4; ++i) { top->clk = 0; top->eval(); top->clk = 1; top->eval(); }
		top->rst_n = 1; top->clk = 0; top->eval();
	}

	// Advance exactly one clock cycle and service the AHB port.
	void step() {
		top->clk = 0; top->eval();
		top->clk = 1; top->eval();      // rising edge: state advances
		++cycles;

		// Service the data phase of the transfer whose address we captured last
		// cycle. hready is held high (zero-wait-state memory).
		if (aphase_vld) {
			if (aphase_write)
				bus_write(aphase_addr, top->hwdata, aphase_size);
			else
				top->hrdata = bus_read(aphase_addr);
		}
		top->hready = 1; top->hexokay = 1; top->hresp = 0;

		// Capture this cycle's address phase for servicing next cycle.
		// htrans[1] distinguishes NONSEQ/SEQ (active) from IDLE/BUSY.
		aphase_vld   = (top->htrans >> 1) & 1;
		aphase_addr  = top->haddr;
		aphase_write = top->hwrite;
		aphase_size  = top->hsize;
	}

	// Run until the program requests exit or `max_cycles` elapse.
	uint64_t run(uint64_t max_cycles) {
		for (uint64_t i = 0; i < max_cycles && !exited; ++i)
			step();
		return cycles;
	}

	bool     exited = false;
	uint32_t exit_code = 0;
	uint64_t cycles = 0;

private:
	Vhz3_top *top;
	std::vector<uint8_t> mem;
	bool     aphase_vld = false;
	uint32_t aphase_addr = 0;
	bool     aphase_write = false;
	uint32_t aphase_size = 0;

	uint32_t bus_read(uint32_t addr) {
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
			fputc((int)(wdata & 0xff), stdout);
		} else if (addr == IO_BASE + IO_PRINT_U32) {
			printf("%08x\n", wdata);
		} else if (addr == IO_BASE + IO_EXIT) {
			if (!exited) { exited = true; exit_code = wdata; }
		}
	}
};

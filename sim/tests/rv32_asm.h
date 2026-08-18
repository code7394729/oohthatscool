/*
 * rv32_asm.h — a few dozen lines of RV32IM instruction encoding, so tests can
 * build their own programs in memory.
 *
 * The tests that matter here are about *microarchitecture*: does a load-use
 * hazard raise the interlock, does a dependent add take its operand from the
 * bypass network, does a rewrite of an unchanged value still register as a
 * write. Each of those wants a three-instruction program engineered to force
 * exactly one behaviour, and wants it in the test next to the assertion it
 * justifies. Shipping .bin fixtures instead would put the interesting part in
 * another file and make the test suite depend on a RISC-V toolchain being
 * installed, which it otherwise does not.
 */
#pragma once

#include <cstdint>
#include <vector>

namespace rv {

// Registers, by ABI name where it helps readability.
enum { x0 = 0, ra = 1, sp = 2, t0 = 5, t1 = 6, t2 = 7, a0 = 10, a1 = 11 };

// CSR numbers used by the tests.
enum { CSR_MCOUNTINHIBIT = 0x320, CSR_MCYCLE = 0xb00, CSR_MINSTRET = 0xb02 };

inline uint32_t r_type(unsigned funct7, unsigned rs2, unsigned rs1,
                       unsigned funct3, unsigned rd, unsigned opcode) {
	return (funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) |
	       (rd << 7) | opcode;
}

inline uint32_t i_type(int32_t imm, unsigned rs1, unsigned funct3,
                       unsigned rd, unsigned opcode) {
	return ((uint32_t)(imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) |
	       (rd << 7) | opcode;
}

inline uint32_t s_type(int32_t imm, unsigned rs2, unsigned rs1,
                       unsigned funct3, unsigned opcode) {
	uint32_t i = (uint32_t)imm;
	return (((i >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) |
	       (funct3 << 12) | ((i & 0x1f) << 7) | opcode;
}

inline uint32_t b_type(int32_t imm, unsigned rs2, unsigned rs1,
                       unsigned funct3, unsigned opcode) {
	uint32_t i = (uint32_t)imm;
	return (((i >> 12) & 1) << 31) | (((i >> 5) & 0x3f) << 25) | (rs2 << 20) |
	       (rs1 << 15) | (funct3 << 12) | (((i >> 1) & 0xf) << 8) |
	       (((i >> 11) & 1) << 7) | opcode;
}

inline uint32_t u_type(uint32_t imm, unsigned rd, unsigned opcode) {
	return (imm & 0xfffff000u) | (rd << 7) | opcode;
}

inline uint32_t j_type(int32_t imm, unsigned rd, unsigned opcode) {
	uint32_t i = (uint32_t)imm;
	return (((i >> 20) & 1) << 31) | (((i >> 1) & 0x3ff) << 21) |
	       (((i >> 11) & 1) << 20) | (((i >> 12) & 0xff) << 12) |
	       (rd << 7) | opcode;
}

inline uint32_t addi(unsigned rd, unsigned rs1, int32_t imm) { return i_type(imm, rs1, 0x0, rd, 0x13); }
inline uint32_t ori (unsigned rd, unsigned rs1, int32_t imm) { return i_type(imm, rs1, 0x6, rd, 0x13); }
inline uint32_t slli(unsigned rd, unsigned rs1, unsigned sh) { return i_type((int32_t)sh, rs1, 0x1, rd, 0x13); }

inline uint32_t add (unsigned rd, unsigned rs1, unsigned rs2) { return r_type(0x00, rs2, rs1, 0x0, rd, 0x33); }
inline uint32_t sub (unsigned rd, unsigned rs1, unsigned rs2) { return r_type(0x20, rs2, rs1, 0x0, rd, 0x33); }
inline uint32_t xor_(unsigned rd, unsigned rs1, unsigned rs2) { return r_type(0x00, rs2, rs1, 0x4, rd, 0x33); }

inline uint32_t mul (unsigned rd, unsigned rs1, unsigned rs2) { return r_type(0x01, rs2, rs1, 0x0, rd, 0x33); }
inline uint32_t divu(unsigned rd, unsigned rs1, unsigned rs2) { return r_type(0x01, rs2, rs1, 0x5, rd, 0x33); }

inline uint32_t lui  (unsigned rd, uint32_t imm) { return u_type(imm, rd, 0x37); }
inline uint32_t auipc(unsigned rd, uint32_t imm) { return u_type(imm, rd, 0x17); }

inline uint32_t lw(unsigned rd, unsigned rs1, int32_t imm)  { return i_type(imm, rs1, 0x2, rd, 0x03); }
inline uint32_t sw(unsigned rs2, unsigned rs1, int32_t imm) { return s_type(imm, rs2, rs1, 0x2, 0x23); }

inline uint32_t beq(unsigned rs1, unsigned rs2, int32_t off) { return b_type(off, rs2, rs1, 0x0, 0x63); }
inline uint32_t bne(unsigned rs1, unsigned rs2, int32_t off) { return b_type(off, rs2, rs1, 0x1, 0x63); }

inline uint32_t jal (unsigned rd, int32_t off)               { return j_type(off, rd, 0x6f); }
inline uint32_t jalr(unsigned rd, unsigned rs1, int32_t imm) { return i_type(imm, rs1, 0x0, rd, 0x67); }

inline uint32_t csrrw (unsigned rd, unsigned csr, unsigned rs1)  { return i_type((int32_t)csr, rs1, 0x1, rd, 0x73); }
inline uint32_t csrrs (unsigned rd, unsigned csr, unsigned rs1)  { return i_type((int32_t)csr, rs1, 0x2, rd, 0x73); }
inline uint32_t csrrwi(unsigned rd, unsigned csr, unsigned uimm) { return i_type((int32_t)csr, uimm, 0x5, rd, 0x73); }

inline uint32_t nop() { return addi(x0, x0, 0); }

// A program under construction. `base` is the reset vector, so pc() gives the
// address the next emitted instruction will live at — which is all the label
// arithmetic these tests need.
class Asm {
public:
	explicit Asm(uint32_t base_addr = 0x80000000u) : base(base_addr) {}

	Asm &operator<<(uint32_t instr) { words.push_back(instr); return *this; }

	uint32_t pc() const { return base + 4u * (uint32_t)words.size(); }
	uint32_t addr_of(size_t index) const { return base + 4u * (uint32_t)index; }
	size_t   size() const { return words.size(); }

	// Park the core: branch to self. Tests run a fixed cycle budget, so
	// programs need a defined end rather than running off into blank memory.
	Asm &park() { return *this << beq(x0, x0, 0); }

	std::vector<uint8_t> bytes() const {
		std::vector<uint8_t> b;
		b.reserve(words.size() * 4);
		for (uint32_t w : words) {
			b.push_back((uint8_t)(w & 0xff));
			b.push_back((uint8_t)((w >> 8) & 0xff));
			b.push_back((uint8_t)((w >> 16) & 0xff));
			b.push_back((uint8_t)((w >> 24) & 0xff));
		}
		return b;
	}

private:
	uint32_t base;
	std::vector<uint32_t> words;
};

} // namespace rv

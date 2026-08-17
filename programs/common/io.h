/* io.h — MMIO helpers for the visualizer SoC's debug I/O block.
 * Freestanding: no standard library headers required. */
#pragma once

#define IO_BASE        0xC0000000u
#define IO_PRINT_CHAR  0x00u   /* write low byte -> host stdout            */
#define IO_PRINT_U32   0x04u   /* write word     -> host prints hex + '\n' */
#define IO_EXIT        0x08u   /* write word     -> stop sim, use as code  */

static inline void io_write(unsigned off, unsigned val) {
	*(volatile unsigned int *)(IO_BASE + off) = val;
}

static inline void putch(char c)          { io_write(IO_PRINT_CHAR, (unsigned char)c); }
static inline void print(const char *s)   { while (*s) putch(*s++); }
static inline void print_u32(unsigned v)  { io_write(IO_PRINT_U32, v); }

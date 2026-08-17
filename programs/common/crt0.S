# crt0.S — minimal startup for freestanding test programs.
#
# Sets gp and sp, zeroes .bss, calls main(), then writes main's return value to
# the MMIO exit register and parks. No libc, no traps assumed.

.section .text.init, "ax"
.global _start
_start:
	# Set up the global pointer (disable relaxation so this la is not
	# rewritten to a gp-relative form before gp is established).
.option push
.option norelax
	la   gp, __global_pointer$
.option pop
	la   sp, _stack_top

	# Zero .bss
	la   t0, __bss_start
	la   t1, __bss_end
1:
	bgeu t0, t1, 2f
	sw   zero, 0(t0)
	addi t0, t0, 4
	j    1b
2:
	call main

	# main() returned: report exit code a0 to the MMIO exit register.
	li   t0, 0xC0000000     # IO_BASE
	sw   a0, 0x08(t0)       # IO_EXIT
3:
	j    3b                 # park

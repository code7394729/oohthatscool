/* Flat single-region layout for the visualizer SoC.
 * RAM is at 0x80000000 (MEM_BASE); the reset vector is the very first byte, so
 * _start (in .text.init) must come first. objcopy -O binary of the resulting
 * ELF gives an image loaded directly at MEM_BASE. */

OUTPUT_ARCH(riscv)
ENTRY(_start)

MEMORY {
	RAM (rwx) : ORIGIN = 0x80000000, LENGTH = 16M
}

SECTIONS {
	. = ORIGIN(RAM);

	.text : {
		KEEP(*(.text.init))   /* _start pinned to the reset vector */
		*(.text*)
	} > RAM

	.rodata : {
		*(.rodata*)
		*(.srodata*)
	} > RAM

	. = ALIGN(8);
	__global_pointer$ = . + 0x800;

	.data : {
		*(.data*)
		*(.sdata*)
	} > RAM

	.bss (NOLOAD) : {
		__bss_start = .;
		*(.bss*)
		*(.sbss*)
		*(COMMON)
		__bss_end = .;
	} > RAM

	. = ALIGN(16);
	_stack_top = ORIGIN(RAM) + LENGTH(RAM);
}

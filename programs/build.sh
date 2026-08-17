#!/usr/bin/env bash
# build.sh — assemble+link a freestanding test program into a flat binary.
#
#   programs/build.sh hello        # builds programs/hello/build/hello.bin
#
# Uses the rv64 bare-metal GCC to target rv32im/ilp32 with no libc.
set -euo pipefail

CROSS=${CROSS:-riscv64-unknown-elf-}
ARCH="-march=rv32im -mabi=ilp32"
HERE="$(cd "$(dirname "$0")" && pwd)"

name="${1:?usage: build.sh <program-name>}"
src="$HERE/$name/$name.c"
out="$HERE/$name/build"
mkdir -p "$out"

"${CROSS}gcc" $ARCH -nostdlib -nostartfiles -ffreestanding -Os -Wall -Wextra \
	-fno-pie -I"$HERE/common" \
	-T "$HERE/common/link.ld" \
	"$HERE/common/crt0.S" "$src" \
	-o "$out/$name.elf"

"${CROSS}objcopy" -O binary "$out/$name.elf" "$out/$name.bin"
"${CROSS}objdump" -d "$out/$name.elf" > "$out/$name.dis"

printf 'built %s (%s bytes)\n' "$out/$name.bin" "$(stat -c%s "$out/$name.bin")"

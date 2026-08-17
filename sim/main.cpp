/*
 * main.cpp — native CLI harness around the Verilated Hazard3 SoC.
 *
 * Loads a flat binary at the reset vector, runs the core until it writes an
 * exit code to the MMIO exit register (or a cycle budget is hit), and forwards
 * the program's UART-style character output to stdout.
 *
 * Usage: hz3_sim --bin prog.bin [--cycles N]
 */
#include "soc.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

int main(int argc, char **argv) {
	std::string bin;
	uint64_t max_cycles = 2000000;

	for (int i = 1; i < argc; ++i) {
		std::string a = argv[i];
		if (a == "--bin" && i + 1 < argc)          bin = argv[++i];
		else if (a == "--cycles" && i + 1 < argc)  max_cycles = strtoull(argv[++i], nullptr, 0);
		else if (a == "--help") {
			printf("usage: %s --bin prog.bin [--cycles N]\n", argv[0]);
			return 0;
		}
	}

	if (bin.empty()) {
		fprintf(stderr, "usage: %s --bin prog.bin [--cycles N]\n", argv[0]);
		return 2;
	}

	Soc soc;
	if (!soc.load_file(bin)) {
		fprintf(stderr, "error: cannot open '%s'\n", bin.c_str());
		return 2;
	}

	soc.run(max_cycles);
	fflush(stdout);

	if (soc.exited)
		fprintf(stderr, "\n[sim] CPU requested exit, code=%u, after %llu cycles\n",
		        soc.exit_code, (unsigned long long)soc.cycles);
	else
		fprintf(stderr, "\n[sim] cycle budget (%llu) exhausted without exit\n",
		        (unsigned long long)soc.cycles);

	return soc.exited ? (int)soc.exit_code : 1;
}

/*
 * main.cpp — native/Node CLI harness around the Verilated Hazard3 SoC.
 *
 * Loads a flat binary at the reset vector, runs the core until it writes an
 * exit code to the MMIO exit register (or a cycle budget is hit), and forwards
 * the program's UART-style character output to stdout.
 *
 * It can also record a JSONL trace: one snapshot per cycle, in exactly the
 * format the WASM bridge hands to the browser. That file is what lets the UI
 * layers be developed and tested with no simulator and no browser — see
 * js/test/run.mjs.
 *
 * Usage: hz3_sim --bin prog.bin [--cycles N] [--trace out.jsonl] ...
 */
#include "soc.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

static void usage(const char *argv0) {
	printf(
		"usage: %s --bin prog.bin [options]\n"
		"\n"
		"  --bin PATH         flat binary to load at the reset vector (0x%08x)\n"
		"  --cycles N         cycle budget (default 2000000)\n"
		"  --trace PATH       write a JSONL snapshot trace ('-' for stdout)\n"
		"  --trace-from N     first cycle to trace (default 0)\n"
		"  --trace-to N       last cycle to trace (default: end of run)\n"
		"  --snapshot         print the final snapshot as JSON on stdout\n"
		"  --quiet            do not echo the program's character output\n"
		"  --help\n",
		argv0, Soc::MEM_BASE);
}

int main(int argc, char **argv) {
	std::string bin, trace_path;
	uint64_t max_cycles = 2000000;
	uint64_t trace_from = 0, trace_to = UINT64_MAX;
	bool want_snapshot = false, quiet = false;

	for (int i = 1; i < argc; ++i) {
		std::string a = argv[i];
		if      (a == "--bin"        && i + 1 < argc) bin = argv[++i];
		else if (a == "--cycles"     && i + 1 < argc) max_cycles = strtoull(argv[++i], nullptr, 0);
		else if (a == "--trace"      && i + 1 < argc) trace_path = argv[++i];
		else if (a == "--trace-from" && i + 1 < argc) trace_from = strtoull(argv[++i], nullptr, 0);
		else if (a == "--trace-to"   && i + 1 < argc) trace_to   = strtoull(argv[++i], nullptr, 0);
		else if (a == "--snapshot")                   want_snapshot = true;
		else if (a == "--quiet")                      quiet = true;
		else if (a == "--help")                     { usage(argv[0]); return 0; }
		else { fprintf(stderr, "error: unrecognised argument '%s'\n", a.c_str()); return 2; }
	}

	if (bin.empty()) { usage(argv[0]); return 2; }

	FILE *trace = nullptr;
	if (!trace_path.empty()) {
		if (trace_path == "-") {
			// A trace on stdout would interleave with the program's own output.
			trace = stdout;
			quiet = true;
		} else if (!(trace = fopen(trace_path.c_str(), "w"))) {
			fprintf(stderr, "error: cannot write '%s'\n", trace_path.c_str());
			return 2;
		}
	}

	Soc soc;
	soc.set_echo(!quiet);
	if (!soc.load_file(bin)) {
		fprintf(stderr, "error: cannot open '%s'\n", bin.c_str());
		return 2;
	}

	if (trace) {
		// Step one cycle at a time so every cycle can be recorded.
		std::string line;
		for (uint64_t i = 0; i < max_cycles && !soc.exited; ++i) {
			soc.step();
			if (soc.cycles < trace_from || soc.cycles > trace_to) continue;
			line.clear();
			hz3::toJson(soc.snapshot(), line);
			line += '\n';
			fwrite(line.data(), 1, line.size(), trace);
		}
		if (trace != stdout) fclose(trace);
	} else {
		soc.run(max_cycles);
	}

	if (want_snapshot)
		printf("%s\n", soc.snapshot_json().c_str());

	fflush(stdout);

	if (soc.exited)
		fprintf(stderr, "\n[sim] CPU requested exit, code=%u, after %llu cycles"
		                " (%llu instructions retired)\n",
		        soc.exit_code, (unsigned long long)soc.cycles,
		        (unsigned long long)soc.retired);
	else
		fprintf(stderr, "\n[sim] cycle budget (%llu) exhausted without exit\n",
		        (unsigned long long)soc.cycles);

	return soc.exited ? (int)soc.exit_code : 1;
}

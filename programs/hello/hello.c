/* hello.c — smoke-test program: print a line, exit with a known code. */
#include "io.h"

int main(void) {
	print("Hello, world from Hazard3 running in WebAssembly!\n");
	return 123;
}

/*
 * vl_hooks.h — the fault record filled in by our $finish / $stop / $fatal
 * handlers (vl_hooks.cpp).
 */
#pragma once

#include <string>

namespace hz3 {

struct SimFault {
	enum Kind { None = 0, Finish, Stop, Fatal };
	Kind        kind = None;
	std::string file;
	int         line = 0;
	std::string hier;
	std::string message;

	bool active() const { return kind != None; }
	const char *kindName() const {
		switch (kind) {
		case Finish: return "finish";
		case Stop:   return "stop";
		case Fatal:  return "fatal";
		default:     return "none";
		}
	}
};

// The first fault raised since the last clear_fault(), if any.
const SimFault &fault();
void clear_fault();

} // namespace hz3

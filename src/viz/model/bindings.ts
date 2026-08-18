/**
 * bindings.ts — what a Snapshot means for each part of the diagram.
 *
 * The third of the three separated concerns: the model says what exists, the
 * layout says where it is, and this says what it is doing right now. It depends
 * on component and net ids and on the Snapshot type, and on nothing visual —
 * no coordinates, no colours, no DOM. The result is a plain object that
 * render/dom.ts writes onto the SVG as data attributes.
 *
 * Keeping it pure is what lets the interesting question — "does the diagram
 * light the forwarding path when the core actually forwards?" — be a unit test
 * rather than a screenshot.
 */

import { hex32, memOpName, mulOpName, regName } from '../../core/decode.js';
import { Bypass, MEMOP_NONE, type Snapshot } from '../../core/snapshot.js';

/** How a component is behaving this cycle. Becomes a `data-state` attribute. */
export type PartState = 'idle' | 'active' | 'stalled' | 'bubble' | 'writing';

export interface ComponentDisplay {
	state: PartState;
	/** Live text shown inside the box: a value, a register name, a mnemonic. */
	value?: string;
	/** For a mux, the index of the selected input; -1 for none. */
	selected?: number;
	/** Extra explanation for the tooltip / inspector. */
	detail?: string;
}

export type NetEmphasis = 'none' | 'highlight' | 'muted';

export interface NetDisplay {
	active: boolean;
	emphasis: NetEmphasis;
	value?: string;
}

export interface DatapathDisplay {
	components: Record<string, ComponentDisplay>;
	nets: Record<string, NetDisplay>;
}

const idle: ComponentDisplay = { state: 'idle' };
const off: NetDisplay = { active: false, emphasis: 'none' };

/**
 * Which bypass mux input corresponds to which Bypass code. The mux's data
 * inputs are in0 = register file, in1 = from M, in2 = from W (see
 * datapath.ts), so this is the one place the two orders are tied together.
 */
function bypassInput(code: number): number {
	switch (code) {
	case Bypass.Regfile: return 0;
	case Bypass.M: return 1;
	case Bypass.W: return 2;
	default: return -1;
	}
}

export function computeDisplay(s: Snapshot): DatapathDisplay {
	const components: Record<string, ComponentDisplay> = {};
	const nets: Record<string, NetDisplay> = {};

	const xLive = s.x.valid;
	const xStalled = s.x.valid && s.x.stall;
	const xState: PartState = !s.x.valid ? 'bubble' : s.x.stall ? 'stalled' : 'active';

	// A wire is "carrying" something when the stage that drives it holds a real
	// instruction. Drawing every wire lit all the time would say nothing.
	const wire = (active: boolean, value?: string, emphasis: NetEmphasis = 'none'): NetDisplay =>
		({ active, emphasis, ...(active && value !== undefined ? { value } : {}) });

	// ---- F ----------------------------------------------------------------
	components['pc'] = { state: s.f.jumpReq ? 'writing' : 'active', value: hex32(s.f.pc) };
	components['imem'] = {
		state: s.bus.iReq ? 'active' : 'idle',
		value: s.bus.iReq ? hex32(s.bus.iAddr) : '',
	};
	components['cir'] = {
		state: s.f.cirVld === 0 ? 'bubble' : xStalled ? 'stalled' : 'active',
		value: s.f.cirVld ? hex32(s.f.cir) : '—',
		...(xStalled ? { detail: 'held: the instruction in execute cannot move on' } : {}),
	};

	nets['pc_imem'] = wire(s.bus.iReq, hex32(s.bus.iAddr));
	nets['imem_cir'] = wire(s.bus.iDphReady, hex32(s.f.cir));
	nets['cir_decode'] = wire(s.f.cirVld > 0, hex32(s.f.cir));

	// ---- X ----------------------------------------------------------------
	components['decode'] = {
		state: xState,
		value: xLive ? `rd=${regName(s.x.rd)}` : '',
	};
	components['xpc'] = { state: xLive ? 'active' : 'idle', value: hex32(s.x.pc) };

	// The register file is "writing" when the strobe is up — the same event the
	// register panel flashes on, so the two agree by construction.
	components['regfile'] = {
		state: s.m.regWen ? 'writing' : xLive ? 'active' : 'idle',
		value: s.m.regWen ? `${regName(s.m.rd)} ← ${hex32(s.m.result)}` : '',
		...(s.m.regWen ? { detail: 'a register is being written this cycle' } : {}),
	};

	const selA = bypassInput(s.x.bypassA);
	const selB = bypassInput(s.x.bypassB);
	components['bypassA'] = {
		state: selA >= 1 ? 'writing' : selA === 0 ? 'active' : 'idle',
		selected: selA,
		value: selA >= 0 ? hex32(s.x.rs1Bypass) : '',
		...(selA >= 1 ? { detail: 'operand taken from a result still in flight' } : {}),
	};
	components['bypassB'] = {
		state: selB >= 1 ? 'writing' : selB === 0 ? 'active' : 'idle',
		selected: selB,
		value: selB >= 0 ? hex32(s.x.rs2Bypass) : '',
		...(selB >= 1 ? { detail: 'operand taken from a result still in flight' } : {}),
	};

	// The operand muxes report which side they picked by comparing the chosen
	// operand against the bypass output — the RTL's select bit is not in the
	// snapshot, and this is exact for every case that matters.
	const opAFromPc = xLive && s.x.opA === s.x.pc && s.x.opA !== s.x.rs1Bypass;
	const opBFromImm = xLive && s.x.opB === s.x.imm && s.x.opB !== s.x.rs2Bypass;
	components['opA'] = {
		state: xState, selected: xLive ? (opAFromPc ? 1 : 0) : -1,
		value: xLive ? hex32(s.x.opA) : '',
	};
	components['opB'] = {
		state: xState, selected: xLive ? (opBFromImm ? 1 : 0) : -1,
		value: xLive ? hex32(s.x.opB) : '',
	};

	const usingMuldiv = xLive && (s.x.stallCause & 0x04) !== 0;
	components['alu'] = {
		state: xLive && !usingMuldiv ? 'active' : 'idle',
		value: xLive ? hex32(s.x.aluResult) : '',
	};
	components['muldiv'] = {
		state: usingMuldiv ? 'stalled' : 'idle',
		value: usingMuldiv ? mulOpName(s.x.mulOp) : '',
		...(usingMuldiv ? { detail: 'sequential unit iterating; execute is held' } : {}),
	};
	components['xres'] = {
		state: xState, selected: usingMuldiv ? 1 : 0,
		value: xLive ? hex32(s.x.aluResult) : '',
	};
	components['branch'] = {
		state: s.x.jumpReq ? 'writing' : xLive ? 'active' : 'idle',
		value: s.x.jumpReq ? hex32(s.f.jumpTarget) : '',
		...(s.x.jumpReq ? { detail: 'redirecting the front end; fetched instructions behind are discarded' } : {}),
	};
	components['hazard'] = {
		state: xStalled ? 'stalled' : selA >= 1 || selB >= 1 ? 'writing' : 'active',
		value: s.x.stall ? s.x.stallReason : selA >= 1 || selB >= 1 ? 'forwarding' : '',
	};

	nets['rs1_addr'] = wire(xLive && s.x.rs1 !== 0, regName(s.x.rs1));
	nets['rs2_addr'] = wire(xLive && s.x.rs2 !== 0, regName(s.x.rs2));
	nets['rd_to_xm'] = wire(xLive && s.x.rd !== 0, regName(s.x.rd));
	nets['memop_to_xm'] = wire(xLive && s.x.memOp !== MEMOP_NONE, memOpName(s.x.memOp));
	nets['imm_opB'] = wire(opBFromImm, hex32(s.x.imm));
	nets['selA'] = wire(xLive);
	nets['selB'] = wire(xLive);
	nets['xres_sel'] = wire(usingMuldiv);

	nets['rf_rd1'] = wire(selA === 0, hex32(s.x.rs1Bypass));
	nets['rf_rd2'] = wire(selB === 0, hex32(s.x.rs2Bypass));

	// The two forwarding paths get emphasis, not just activity: when either is
	// live it is the most interesting thing on the screen.
	const fwdM = selA === 1 || selB === 1;
	const fwdW = selA === 2 || selB === 2;
	nets['fwd_m'] = {
		active: fwdM, emphasis: fwdM ? 'highlight' : 'none',
		...(fwdM ? { value: hex32(s.m.xmResult) } : {}),
	};
	nets['fwd_w'] = {
		active: fwdW || s.m.regWen, emphasis: fwdW ? 'highlight' : 'none',
		...(fwdW || s.m.regWen ? { value: hex32(s.m.result) } : {}),
	};

	nets['hz_selA'] = wire(selA >= 1);
	nets['hz_selB'] = wire(selB >= 1);
	nets['hz_stall'] = {
		active: s.x.stall,
		emphasis: s.x.stall ? 'highlight' : 'none',
		...(s.x.stall ? { value: s.x.stallReason } : {}),
	};
	nets['xm_rd'] = wire(s.m.valid && s.m.rd !== 0, regName(s.m.rd));

	nets['bypA_opA'] = wire(selA >= 0, hex32(s.x.rs1Bypass));
	nets['bypB_opB'] = wire(selB >= 0, hex32(s.x.rs2Bypass));
	nets['xpc_opA'] = wire(xLive, hex32(s.x.pc));
	nets['opA_alu'] = wire(xLive, hex32(s.x.opA));
	nets['opB_alu'] = wire(xLive, hex32(s.x.opB));
	nets['alu_out'] = wire(xLive, hex32(s.x.aluResult));
	nets['muldiv_out'] = wire(usingMuldiv);
	nets['xres_xm'] = wire(xLive && s.x.issue, hex32(s.x.aluResult));
	nets['branch_pc'] = {
		active: s.x.jumpReq,
		emphasis: s.x.jumpReq ? 'highlight' : 'none',
		...(s.x.jumpReq ? { value: hex32(s.f.jumpTarget) } : {}),
	};

	// ---- M ----------------------------------------------------------------
	const isLoad = s.m.memOp <= 0x04;
	const isStore = s.m.memOp >= 0x05 && s.m.memOp <= 0x07;
	components['xm'] = {
		state: !s.m.valid ? 'bubble' : s.m.stall ? 'stalled' : 'active',
		value: s.m.valid ? hex32(s.m.xmResult) : '—',
	};
	components['dmem'] = {
		state: s.m.dphaseInFlight ? (s.m.busStall ? 'stalled' : 'active') : 'idle',
		value: s.m.dphaseInFlight ? `${memOpName(s.m.memOp)} ${hex32(s.bus.dAddr)}` : '',
	};
	components['resultMux'] = {
		state: s.m.valid ? 'active' : 'idle',
		selected: s.m.valid ? (isLoad ? 1 : 0) : -1,
		value: s.m.valid ? hex32(s.m.result) : '',
	};
	components['wb'] = {
		state: s.m.regWen ? 'writing' : 'idle',
		value: s.m.regWen ? `${regName(s.m.rd)} ← ${hex32(s.m.result)}` : '',
		...(s.m.regWen
			? { detail: 'write strobe up — this is what makes the register flash, even if the value is unchanged' }
			: {}),
	};

	nets['xm_to_result'] = wire(s.m.valid, hex32(s.m.xmResult));
	nets['dmem_rdata'] = wire(isLoad && s.m.dphaseInFlight, hex32(s.bus.dRdata));
	nets['result_sel'] = wire(s.m.valid);
	nets['wb_waddr'] = wire(s.m.regWen, regName(s.m.rd));
	nets['wb_wen'] = {
		active: s.m.regWen,
		emphasis: s.m.regWen ? 'highlight' : 'none',
		...(s.m.regWen ? { value: '1' } : {}),
	};
	nets['alu_out'] = wire(xLive, hex32(s.x.aluResult));
	if (isStore) nets['bypB_opB'] = wire(true, hex32(s.bus.dWdata), 'highlight');

	return { components, nets };
}

/** Everything dark — the state before a program is loaded. */
export function blankDisplay(componentIds: string[], netIds: string[]): DatapathDisplay {
	return {
		components: Object.fromEntries(componentIds.map((id) => [id, idle])),
		nets: Object.fromEntries(netIds.map((id) => [id, off])),
	};
}

/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as net from 'net'
import * as childProcess from 'child_process'

export interface FileAccessor {
	readFile(path: string): Promise<string>;
}

export interface IRuntimeBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

interface IRuntimeStepInTargets {
	id: number;
	label: string;
}

interface IRuntimeStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column?: number;
	instruction?: number;
}

interface IRuntimeStack {
	count: number;
	frames: IRuntimeStackFrame[];
}

interface RuntimeDisassembledInstruction {
	address: number;
	instruction: string;
}

export type IRuntimeVariableType = number | boolean | string | IRuntimeVariable[];

export interface IRuntimeVariable {
	name: string;
	child: number;
	value: IRuntimeVariableType;
	type: string;
}

interface Word {
	name: string;
	index: number
}

interface Session {
	socket: net.Socket
	callbacks: Map<string, Function>
}

export function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A Mock runtime with minimal debugger functionality.
 */
export class MockRuntime extends EventEmitter {

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string = '';
	public get sourceFile() {
		return this._sourceFile;
	}

	private _variables = new Map<string, IRuntimeVariable>();

	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];
	private _instructions: Word[] = [];
	private _starts: number[] = [];

	// This is the next line that will be 'executed'
	private __currentLine = 0;
	private get _currentLine() {
		return this.__currentLine;
	}
	private set _currentLine(x) {
		this.__currentLine = x;
		this._instruction = this._starts[x];
	}
	private _currentColumn: number | undefined;

	// This is the next instruction that will be 'executed'
	public _instruction= 0;

	// maps from sourceFile to array of IRuntimeBreakpoint
	private _breakPoints = new Map<string, IRuntimeBreakpoint[]>();

	// all instruction breakpoint addresses
	private _instructionBreakpoints = new Set<number>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Map<string, string>();

	public debug;


	private _clients: Session | undefined 

	private static _server: net.Server|undefined
	private static _process: childProcess.ChildProcessWithoutNullStreams|undefined


	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public async start(args: any): Promise<void> {

		const createServer = () =>
            new Promise<number>((resolve, reject) => {
                MockRuntime._server = (net.createServer())
                MockRuntime._server.on('connection', async (socket: net.Socket) => {
					let session:Session = {
						socket: socket,
						callbacks: new Map<string, Function>()
					}
					this._clients =  session
					let response = ""
					socket.on('data', data => {
						console.log(data)
						response += data.toString()
						const newline = response.indexOf('\n')
						if (newline > -1) {
							const cmd = JSON.parse(response.slice(0, newline))
							response = response.slice(newline + 1)
							switch (cmd.type) {
								case "Break":
									this._currentLine = parseInt(cmd.line)
									this._sourceFile = cmd.file
									this.sendEvent('stopOnBreakpoint', cmd.threadId);
									break
								case "Stacktrace":
									let cb: Function|undefined = session.callbacks.get("Stacktrace")
									if (cb) {
										cb(cmd)
										session.callbacks.delete("Stacktrace")
									}
									break
								case "Next":
									let next: Function|undefined = session.callbacks.get("Next")
									if (next) {
										next(cmd)
										session.callbacks.delete("Next")
									}
									break
								case "Vars":
									let lv: Function|undefined = session.callbacks.get("Vars")
									if (lv) {
										lv(cmd.vars)
										session.callbacks.delete("Vars")
									}
									break
								case "Scopes":
									let sp: Function|undefined = session.callbacks.get("Scopes")
									if (sp) {
										sp(cmd.scopes)
										session.callbacks.delete("Scopes")
									}
									break
							}
						}
					})
					this.syncAllBp()
					socket.on('close', err => {
						this._clients = undefined
					})
					this.sendEvent('ChildReady')
				})
				MockRuntime._server.on('error', (error: Error) => {
                    reject(error)
                })
                MockRuntime._server.on('listening', () => {
                    const port = 0
					if (MockRuntime._server) {
						(MockRuntime._server.address() as net.AddressInfo).port
					}
                    resolve(port)
                })
                MockRuntime._server.listen(5678, args.hostname)
				return MockRuntime._server
			})
		try {
			if (!args.noDebug) {
				if (MockRuntime._process == undefined && (args.startProcess == undefined || args.startProcess == true)) {
					MockRuntime._process = this.startProgram(args.runtimeExecutable, args.runtimeArgs, args.cwd)
				}
				if (MockRuntime._server == undefined) {
					await createServer()
				}
			}
		} catch (error) {
			this.sendEvent('output', error, '', '', '')
			return 
		}

	}

	public disconnect(args: any) {
		if (MockRuntime._process) {
			process.kill(-MockRuntime._process.pid)
		}
		if (MockRuntime._server) {
			MockRuntime._server.close(err => {
				this.sendEvent('output', "Error while close server " + err)
			})
		}
	}

	private startProgram(exe: string, args: Array<string>, cwd: string): childProcess.ChildProcessWithoutNullStreams {
		const process = childProcess.spawn(exe, [...args], {cwd: cwd, detached: true})
		process.stdout.on('data', (data: Buffer) => {
			this.sendEvent('output', data + '', '', '', '')
		})
		process.stderr.on('data', (data: Buffer) => {
			this.sendEvent('output', data + '', '', '', '')
		})
		process.on('exit', () => {
			this.sendEvent('end')
		})
		process.on('error', (error: Error) => {
			this.sendEvent('out', error)
		})
		return process
	}

	public sendCommand(action:string, data: any, id: number) {
		let command = {data: data, action: action, id: id}
		let stream = JSON.stringify(command)
		const client = this._clients
		if (client) {
			client.socket.write(stream, err => {
				console.log(err)
			})
		}
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue(id: number) {
		this.sendCommand("Continue", null, id)
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(id: number) {
		this.sendCommand("NextLine", null, id)
		return new Promise((resolve, reject) => {
			let client = this._clients
			if (client) {
				client.callbacks.set("Next", data => {
					this._currentLine = data.line
					this._sourceFile = data.file
					this.sendEvent('stopOnStep', id);
				})
			} else {
				reject(-1)
			}
		})
	}

	/**
	 * "Step into" for Mock debug means: go to next character
	 */
	public stepIn(id: number) {
		this.sendCommand("StepInto", null, id)
		return new Promise((resolve, reject) => {
			let client = this._clients
			if (client) {
				client.callbacks.set("Next", data => {
					this._currentLine = data.line
					this._sourceFile = data.file
					this.sendEvent('stopOnStep', id)
				})
			}
		})
	}

	/**
	 * "Step out" for Mock debug means: go to previous character
	 */
	public stepOut() {
		if (typeof this._currentColumn === 'number') {
			this._currentColumn -= 1;
			if (this._currentColumn === 0) {
				this._currentColumn = undefined;
			}
		}
		this.sendEvent('stopOnStep');
	}

	public getStepInTargets(frameId: number): IRuntimeStepInTargets[] {

		const line = this.getLine();
		const words = this.getWords(line);

		// return nothing if frameId is out of range
		if (frameId < 0 || frameId >= words.length) {
			return [];
		}

		const { name, index  }  = words[frameId];

		// make every character of the frame a potential "step in" target
		return name.split('').map((c, ix) => {
			return {
				id: index + ix,
				label: `target: ${c}`
			};
		});
	}

	public stack(startFrame: number, endFrame: number, threadId:  number): Promise<IRuntimeStack> {
		return new Promise((resolve, reject) => {
			this.sendCommand("Stacktrace", [], threadId)
			let client = this._clients
			if (client) {
				client.callbacks.set("Stacktrace", data => {
					resolve(this.stackResponse(data, threadId))
				})
			} else {
				reject(-1)
			}
		})
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stackResponse(ret: any, id: number): IRuntimeStack {
		const frames: IRuntimeStackFrame[] = [];
		// every word of the current line becomes a stack frame.
		for (let i = 0; i < ret.stack.length; i++) {
			let sf = ret.stack[i]
			const stackFrame: IRuntimeStackFrame = {
				index: sf.Index,
				name: sf.Name,	
				file: sf.File,
				line: sf.Line,
				column: sf.Column, 
				instruction: sf.Instruction
			};

			frames.push(stackFrame);
		}

		return {
			frames: frames,
			count: ret.stack.length
		}
	}

	/*
	 * Determine possible column breakpoint positions for the given line.
	 * Here we return the start location of words with more than 8 characters.
	 */
	public getBreakpoints(path: string, line: number): number[] {
		return this.getWords(this.getLine(line)).filter(w => w.name.length > 8).map(w => w.index);
	}

	public syncAllBp() {
		this._breakPoints.forEach((value, key) => {
			this.syncBreakPoint(key)
		})	
	}

	public async syncBreakPoint(path: string) {
		let bps = this._breakPoints.get(path);
		this.sendCommand("SyncBreakpoint", {bps: bps, file: path}, -1)
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number): Promise<IRuntimeBreakpoint> {
		const bp: IRuntimeBreakpoint = { verified: true, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
 	        bps = new Array<IRuntimeBreakpoint>();
 	        this._breakPoints.set(path, bps);
		}
		bps.push(bp);
		
		this.syncBreakPoint(path)
		return bp
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): IRuntimeBreakpoint | undefined {
		const bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	public clearBreakpoints(path: string): void {
		this._breakPoints.delete(path);
		this.syncBreakPoint(path)
	}

	public setDataBreakpoint(address: string, accessType: 'read' | 'write' | 'readWrite'): boolean {

		const x = accessType === 'readWrite' ? 'read write' : accessType;

		const t = this._breakAddresses.get(address);
		if (t) {
			if (t !== x) {
				this._breakAddresses.set(address, 'read write');
			}
		} else {
			this._breakAddresses.set(address, x);
		}
		return true;
	}

	public clearAllDataBreakpoints(): void {
		this._breakAddresses.clear();
	}
	
	public setExceptionsFilters(namedException: string | undefined, otherExceptions: boolean): void {
	}

	public setInstructionBreakpoint(address: number): boolean {
		this._instructionBreakpoints.add(address);
		return true;
	}

	public clearInstructionBreakpoints(): void {
		this._instructionBreakpoints.clear();
	}

	public async getGlobalVariables(cancellationToken?: () => boolean ): Promise<IRuntimeVariable[]> {

		let a: IRuntimeVariable[] = [];

		for (let i = 0; i < 10; i++) {
			a.push({
				name: `global_${i}`,
				value: i,
				child: 0,
				type: "",
			});
			if (cancellationToken && cancellationToken()) {
				break;
			}
			await timeout(1000);
		}

		return a;
	}

	public scope(id: number, frame: number): Promise<any> {
		this.sendCommand("Scopes", {frame: frame}, id)
		return new Promise((resolve, reject) => {
			let client = this._clients
			try {
				if (client) {
					client.callbacks.set("Scopes", (data: any) => {
						resolve(data)
					})
				}
			} catch (error) {
				this.sendEvent('output', error)
			}
		})
	}

	public getVariables(id: number, ref: number, path: string[], frameId: number): Promise<IRuntimeVariable[]> {
		this.sendCommand("Vars", {ref, path, frameId}, id)
		return new Promise((resolve, reject) => {
			let client = this._clients
			try {
				if (client) {
					client?.callbacks.set("Vars", (data: any) => {
						let ret: IRuntimeVariable[] = []
						for (const key in data) {
							const item = data[key]
							ret.push({
								name: item.Name,
								value: item.Value,
								child: item.Children.length,
								type: item.Type,
							})
						}
						ret.sort((a, b): number => {
							return a < b ? -1 : 1
						})
						resolve(ret)
					})
				}
			} catch (error) {
				this.sendEvent('output', error)
			}
		})
	}

	public getLocalVariable(name: string): IRuntimeVariable | undefined {
		return this._variables.get(name);
	}

	/**
	 * Return words of the given address range as "instructions"
	 */
	public disassemble(address: number, instructionCount: number): RuntimeDisassembledInstruction[] {

		const instructions: RuntimeDisassembledInstruction[] = [];

		for (let a = address; a < address + instructionCount; a++) {
			instructions.push({
				address: a,
				instruction: (a >= 0 && a < this._instructions.length) ? this._instructions[a].name : 'nop'
			});
		}

		return instructions;
	}

	// private methods

	private getLine(line?: number): string {
		return this._sourceLines[line === undefined ? this._currentLine : line].trim();
	}

	private getWords(line: string): Word[] {
		// break line into words
		const WORD_REGEXP = /[a-z]+/ig;
		const words: Word[] = [];
		let match: RegExpExecArray | null;
		while (match = WORD_REGEXP.exec(line)) {
			words.push({ name: match[0], index: match.index });
		}
		return words;
	}


	private sendEvent(event: string, ... args: any[]): void {
		setImmediate(() => {
			this.emit(event, ...args);
		});
	}
}
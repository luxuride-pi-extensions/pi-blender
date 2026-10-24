import type { TSchema } from "typebox";

export interface CoreToolContext {
	cwd?: string;
	signal?: AbortSignal;
}

export interface CoreToolContent {
	type: "text";
	text: string;
}

export interface CoreToolResult {
	content: CoreToolContent[];
	details: unknown;
	isError?: boolean;
}

/**
 * MCP-style annotations. A client uses these to decide whether to prompt the
 * user before a call, so they are part of the transport-agnostic contract, not
 * a pi detail: a wrong hint is a wrong permission decision whichever transport
 * reads it.
 */
export interface CoreToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface CoreToolDefinition<TParams = any> {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	/** Hints a host uses to gate the tool. Forwarded verbatim to pi and to MCP. */
	annotations?: CoreToolAnnotations;
	/** pi's registration flag; other transports ignore it. */
	defaultActive?: boolean;
	readOnly?: boolean;
	execute: (params: TParams, context?: CoreToolContext) => Promise<CoreToolResult>;
}

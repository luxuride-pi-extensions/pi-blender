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

export interface CoreToolDefinition<TParams = any> {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	readOnly?: boolean;
	execute: (params: TParams, context?: CoreToolContext) => Promise<CoreToolResult>;
}

/**
 * MCP `outputSchema` for the results a client can render without parsing prose.
 *
 * Deliberately loose: `additionalProperties: true` because a result carries
 * stage-specific detail that changes between releases, and a client that
 * hard-fails on an unknown key would break on every feature. The listed keys
 * are the stable ones, the ones a caller may branch on.
 *
 * The stable names are a normalisation, not a rename of the handler result: the
 * same concept is spelled `blendPath`, `branchPath` and `exportPath` per tool,
 * and a client that has to guess which is which is back to parsing the text
 * block. `core/mcp-server.ts` adds the aliases alongside the raw fields.
 */

export const PREFLIGHT_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: true,
	description: "Structural checks measured before a run or apply.",
	properties: {
		profile: { type: "string" },
		blocking: { type: "boolean", description: "True when a blocker stopped the stage." },
		blockers: { type: "array", items: { type: "string" } },
		warnings: { type: "array", items: { type: "string" } },
		checks: { type: "object", additionalProperties: true },
	},
};

const STABLE_PROPERTIES = {
	path: { type: "string", description: "Primary artifact this result is about." },
	digest: { type: "string", description: "Content hash of the applied state, when one was measured." },
	changed: { type: "boolean", description: "True when the stage changed the scene's content." },
	warnings: { type: "array", items: { type: "string" } },
	validation: PREFLIGHT_OUTPUT_SCHEMA,
	counts: { type: "object", additionalProperties: { type: "number" } },
} as const;

export const OUTPUT_SCHEMAS: Record<string, unknown> = {
	blender_scene_info: {
		type: "object",
		additionalProperties: true,
		properties: {
			...STABLE_PROPERTIES,
			counts: {
				type: "object",
				additionalProperties: { type: "number" },
				description: "objects, materials, collections: the scene's size without walking the arrays.",
			},
		},
	},
	blender_branch_run: {
		type: "object",
		additionalProperties: true,
		properties: {
			...STABLE_PROPERTIES,
			blocked: {
				type: "boolean",
				description: "A blocking preflight stopped the render; the run itself still succeeded.",
			},
			status: { type: "string" },
			reused: { type: "boolean" },
		},
	},
	blender_branch_apply: {
		type: "object",
		additionalProperties: true,
		properties: {
			...STABLE_PROPERTIES,
			status: { type: "string", description: "conflict when a contested module was skipped." },
			counts: {
				type: "object",
				additionalProperties: { type: "number" },
				description: "applied, skipped, missing.",
			},
		},
	},
	blender_export_asset: {
		type: "object",
		additionalProperties: true,
		properties: {
			...STABLE_PROPERTIES,
			format: { type: "string" },
			counts: {
				type: "object",
				additionalProperties: { type: "number" },
				description: "bytes, meshCount, objectCount, textureCount.",
			},
		},
	},
};

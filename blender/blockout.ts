/**
 * Provider-neutral ingress for generative blockouts.
 *
 * A blockout is a starting point, not a module output: it is dense, open and
 * usually unwrapped. Stage 1 therefore has two providers — a local file the
 * caller already owns, and a ComfyUI graph at a URL the caller configured — and
 * nothing that holds an API key, because a key in a workspace file is a key in
 * a git history.
 *
 * Everything else (Hunyuan, TRELLIS, Meshy, Tripo) is deferred, and refusing
 * them by name beats accepting a provider we cannot verify: a caller who typed
 * `provider: "meshy"` deserves to hear that it is not wired yet, not to get a
 * local import of a file that was never produced.
 *
 * The geometry itself is imported by the bridge, in its own `Blockout`
 * collection, tagged `pi_blender_blockout`, so `validate()` refuses it for
 * character, hard_surface and print until somebody rebuilds it. That refusal is
 * the point of the tool.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { requestBridge } from "./bridge.js";
import { dispatchDeferredJob } from "./jobs.js";
import type {
	BlockoutGenerateOptions,
	BlockoutGenerateResult,
	BlockoutProvenance,
	BlenderWorkspaceManifest,
} from "./types.js";
import { nowIso, runBlenderJson } from "./utils.js";
import { getManifestPath, loadWorkspaceManifest, updateManifest } from "./workspace.js";

/** Providers that exist in Stage 1. */
export const BLOCKOUT_PROVIDERS = ["local", "comfyui"] as const;

/**
 * Providers the issue describes and this stage does not implement. Kept as data
 * so the refusal names them, and so adding one later is a branch, not a guess.
 */
export const DEFERRED_BLOCKOUT_PROVIDERS = ["hunyuan", "trellis", "meshy", "tripo"] as const;

/** Mesh formats the import path accepts. */
const BLOCKOUT_EXTENSIONS = new Set([".glb", ".gltf", ".obj"]);

/** How long a ComfyUI queue item may sit before we stop waiting for it. */
const COMFYUI_TIMEOUT_MS = 180_000;
const COMFYUI_POLL_MS = 1_000;

interface BridgeBlockoutResponse {
	success: boolean;
	status?: string;
	format?: string;
	sourcePath?: string;
	blendPath?: string | null;
	collection?: string;
	objects?: string[];
	notes?: string[];
	warnings?: string[];
	provenance?: BlockoutProvenance;
	error?: string;
}

interface ComfyUiHistoryEntry {
	status?: { completed?: boolean; status_str?: string; messages?: unknown };
	outputs?: Record<string, Record<string, unknown>>;
}

function fail(message: string): never {
	throw new Error(message);
}

function blockoutId(raw: string | undefined, provider: string): string {
	const base = (raw ?? `${provider}-blockout`).trim();
	const cleaned = base
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return cleaned.length > 0 ? cleaned : "blockout";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((done, abort) => {
		if (signal?.aborted) {
			abort(new Error("Blockout generation was aborted."));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			done();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			abort(new Error("Blockout generation was aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Hostnames an override may point at: the machine this process runs on. */
function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host === "::1" || host === "[::1]") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The ComfyUI endpoint: the user's configured URL, or a loopback override.
 *
 * `override` exists for code and tests — the tool schema deliberately does not
 * expose a URL parameter — and it is restricted to loopback so that adding one
 * later cannot silently turn into "a model points the tool, and the user's
 * prompt and reference image, at a host of its choosing". The environment
 * variable is the user's own configuration and may name any host, because a
 * ComfyUI box on the LAN is a legitimate thing to run.
 */
function comfyUiEndpoint(override?: string): string {
	const fromOverride = override !== undefined;
	const raw = (override ?? process.env.PI_BLENDER_COMFYUI_URL ?? "").trim();
	if (raw.length === 0) {
		fail(
			"provider \"comfyui\" needs PI_BLENDER_COMFYUI_URL set to the ComfyUI base URL " +
				"(for example http://127.0.0.1:8188). There is no default endpoint and no key is " +
				"read from the workspace, so the tool cannot guess one.",
		);
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		fail(`PI_BLENDER_COMFYUI_URL is not a URL: "${raw}". Expected something like http://127.0.0.1:8188.`);
	}
	if (fromOverride && !isLoopbackHost(url.hostname)) {
		fail(
			`comfyUrl must be a loopback address, not "${url.hostname}": the override is for code and ` +
				`tests, and it is not exposed on the tool. Set PI_BLENDER_COMFYUI_URL to reach a ` +
				`ComfyUI instance on another host.`,
		);
	}
	return url.href.replace(/\/+$/, "");
}

/** A filename for the generated file, from the workflow output or the id. */
function pickMeshFile(outputs: Record<string, Record<string, unknown>>): string | undefined {
	const candidates: string[] = [];
	for (const node of Object.values(outputs)) {
		for (const value of Object.values(node)) {
			if (!Array.isArray(value)) continue;
			for (const item of value) {
				if (typeof item !== "object" || item === null) continue;
				const record = item as Record<string, unknown>;
				const filename = typeof record.filename === "string" ? record.filename : undefined;
				if (!filename) continue;
				if (BLOCKOUT_EXTENSIONS.has(extname(filename).toLowerCase())) {
					const subfolder = typeof record.subfolder === "string" ? record.subfolder : "";
					const type = typeof record.type === "string" ? record.type : "output";
					candidates.push(`${encodeURIComponent(filename)}?subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`);
				}
			}
		}
	}
	return candidates[0];
}

/**
 * Queue the graph, wait for it, and download the mesh it produced.
 *
 * ComfyUI is a queue with no callback, so this is a submit-then-poll loop: POST
 * /prompt returns a prompt id, and /history/{id} starts describing the run only
 * once it has finished. A run that never appears times out rather than hanging
 * the tool.
 */
async function generateWithComfyUi(
	options: BlockoutGenerateOptions,
	endpoint: string,
	destination: string,
): Promise<string> {
	const timeoutMs = options.timeoutMs ?? COMFYUI_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;

	const queued = await fetch(`${endpoint}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			prompt: options.workflow,
			client_id: "pi-blender",
			...(options.imagePath ? { extra_data: { reference_image: options.imagePath } } : {}),
		}),
		signal: options.signal,
	});
	if (!queued.ok) {
		const detail = await queued.text().catch(() => "");
		fail(`ComfyUI rejected the workflow: ${queued.status} ${queued.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ""}`);
	}
	const submitted = (await queued.json().catch(() => ({}))) as { prompt_id?: string; error?: unknown };
	const promptId = submitted.prompt_id;
	if (!promptId) {
		fail(`ComfyUI did not return a prompt_id: ${JSON.stringify(submitted).slice(0, 400)}`);
	}

	let history: Record<string, ComfyUiHistoryEntry> = {};
	for (;;) {
		if (options.signal?.aborted) fail("Blockout generation was aborted.");
		if (Date.now() > deadline) {
			fail(`ComfyUI did not finish prompt ${promptId} within ${Math.round(timeoutMs / 1000)}s.`);
		}
		const polled = await fetch(`${endpoint}/history/${promptId}`, { signal: options.signal });
		if (!polled.ok) {
			fail(`ComfyUI history for prompt ${promptId} failed: ${polled.status} ${polled.statusText}`);
		}
		history = (await polled.json().catch(() => ({}))) as Record<string, ComfyUiHistoryEntry>;
		if (history[promptId]) break;
		await sleep(COMFYUI_POLL_MS, options.signal);
	}

	const entry = history[promptId] ?? {};
	const meshFile = pickMeshFile(entry.outputs ?? {});
	if (!meshFile) {
		fail(
			`ComfyUI finished prompt ${promptId} without a .glb, .gltf or .obj output. ` +
				"Set the workflow's output node to a mesh exporter and try again.",
		);
	}
	const download = await fetch(`${endpoint}/view?filename=${meshFile}`, { signal: options.signal });
	if (!download.ok) {
		fail(`ComfyUI could not serve ${decodeURIComponent(meshFile)}: ${download.status} ${download.statusText}`);
	}
	const bytes = Buffer.from(await download.arrayBuffer());
	await mkdir(join(destination, ".."), { recursive: true });
	await writeFile(destination, bytes);
	return destination;
}

/**
 * An empty blend for a blockout to land in.
 *
 * A blockout is deliberately not merged into model.blend, so it needs a
 * container of its own, and the bridge will only open a blend that exists. The
 * scene is emptied first: `createBlankBlend` keeps Blender's startup cube and
 * camera, which would then sit in every blockout file and be appended along with
 * the geometry it is meant to hold.
 */
async function createBlockoutBlend(blendPath: string, cwd: string, signal?: AbortSignal): Promise<void> {
	await runBlenderJson({
		cwd,
		scriptSource: `
import bpy, json, sys
payload = json.loads(sys.argv[sys.argv.index("--") + 1])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.save_as_mainfile(filepath=payload["blendPath"])
print("__PI_BLENDER_JSON_START__" + json.dumps({"blendPath": payload["blendPath"]}) + "__PI_BLENDER_JSON_END__")
`,
		payload: { blendPath },
		signal,
	});
}

/**
 * Import a file into the workspace as a blockout and record where it came from.
 *
 * The bridge owns the geometry work -- collection, tag, normalisation -- because
 * it is the half that has Blender. What happens here is custody: a checkpoint of
 * the workspace identifier files, the manifest record, and the honest reporting
 * that this file is not fit to ship.
 */
async function importBlockout(
	options: BlockoutGenerateOptions,
	sourcePath: string,
	provider: string,
): Promise<BlockoutGenerateResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const blockoutsDir = join(manifest.workspacePath, "blockouts");
	await mkdir(blockoutsDir, { recursive: true });

	const id = blockoutId(options.id, provider);
	const blendPath = join(blockoutsDir, `${id}.blend`);
	// Custody: the record points at a file inside the workspace, so a blockout
	// downloaded into a temp dir does not leave provenance pointing at a path
	// that is gone by the next turn.
	const storedPath = join(blockoutsDir, `${id}${extname(sourcePath).toLowerCase()}`);
	if (sourcePath !== storedPath) await copyFile(sourcePath, storedPath);

	if (!existsSync(blendPath)) await createBlockoutBlend(blendPath, options.cwd, options.signal);

	const response = await requestBridge<BridgeBlockoutResponse>({
		payload: {
			type: "blockout-import",
			blendPath,
			sourcePath,
			provider,
			license: options.license,
			prompt: options.prompt,
			seed: options.seed,
			id,
			targetBounds: options.targetBounds,
		},
		label: "blockout-import",
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});

	if (!response.success) {
		return {
			success: false,
			status: response.status ?? "failed",
			provider,
			sourcePath,
			objects: [],
			notes: [],
			warnings: [],
			provenance: response.provenance as BlockoutProvenance,
			error: response.error ?? "Blockout import failed",
		};
	}

	const provenance: BlockoutProvenance = {
		...(response.provenance as BlockoutProvenance),
		id,
		path: storedPath,
		provider,
		license: options.license,
		prompt: options.prompt,
		seed: options.seed,
		blockout: true,
	};

	await updateManifest(getManifestPath(manifest.workspacePath), (current: BlenderWorkspaceManifest) => {
		current.blockouts = [...(current.blockouts ?? []).filter((entry) => entry.id !== id), provenance];
		current.updatedAt = nowIso();
	});

	return {
		success: true,
		status: "imported",
		provider,
		blockoutPath: storedPath,
		blendPath: response.blendPath ?? blendPath,
		collection: response.collection ?? "Blockout",
		objects: response.objects ?? [],
		notes: response.notes ?? [],
		warnings: response.warnings ?? [],
		provenance,
		workspacePath: manifest.workspacePath,
	};
}

export async function blenderBlockoutGenerate(
	options: BlockoutGenerateOptions,
): Promise<BlockoutGenerateResult> {
	const provider = (options.provider ?? "").trim().toLowerCase();

	if ((DEFERRED_BLOCKOUT_PROVIDERS as readonly string[]).includes(provider)) {
		fail(
			`The "${provider}" provider is deferred: Stage 1 supports only ` +
				`${BLOCKOUT_PROVIDERS.map((name) => `"${name}"`).join(" and ")}. ` +
				`Hunyuan, TRELLIS, Meshy and Tripo are not wired up yet, so nothing was generated or imported.`,
		);
	}
	if (!(BLOCKOUT_PROVIDERS as readonly string[]).includes(provider)) {
		fail(
			`Unknown blockout provider "${options.provider}". Use "local" for a GLB/OBJ you already have, ` +
				`or "comfyui" with PI_BLENDER_COMFYUI_URL set.`,
		);
	}
	if (!options.license || options.license.trim().length === 0) {
		fail("A blockout needs a license: provenance that cannot state its licence cannot be shipped.");
	}
	// The provider checks come before any workspace read: a call that cannot
	// possibly run should not report a missing manifest first.
	const endpoint = provider === "comfyui" ? comfyUiEndpoint(options.comfyUrl) : undefined;
	if (provider === "comfyui" && !options.workflow) {
		fail(
			'provider "comfyui" needs a workflow: pass the API-format graph as { workflow: {...} }. ' +
				"The tool cannot invent a node graph for you.",
		);
	}
	if (options.async && provider !== "comfyui") {
		fail("async is only meaningful for provider \"comfyui\"; a local import finishes now.");
	}
	if (options.async) {
		const handle = await dispatchDeferredJob(
			"blockout-generate",
			(signal) => blenderBlockoutGenerate({ ...options, async: false, signal }),
			{ provider, prompt: options.prompt, license: options.license },
		);
		return {
			success: true,
			status: "queued",
			provider,
			jobId: handle.jobId,
			objects: [],
			notes: [],
			warnings: [],
		};
	}

	if (provider === "local") {
		if (!options.path) {
			fail(
				'provider "local" needs a path to the .glb, .gltf or .obj you want to import as a blockout.',
			);
		}
		const sourcePath = isAbsolute(options.path) ? options.path : resolve(options.cwd, options.path);
		if (!existsSync(sourcePath)) {
			fail(`Blockout source file does not exist: "${sourcePath}".`);
		}
		if (!BLOCKOUT_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
			fail(`Blockout source must be .glb, .gltf or .obj, not "${extname(sourcePath) || sourcePath}".`);
		}
		return await importBlockout(options, sourcePath, provider);
	}

	// The download lands in a staging file first: the workspace is not read
	// until there is geometry to put in it, so a workflow that produced nothing
	// never leaves a half-created workspace behind.
	const staging = join(tmpdir(), `pi-blockout-${process.pid}-${Date.now()}.glb`);
	try {
		const generatedPath = await generateWithComfyUi(options, endpoint as string, staging);
		return await importBlockout(options, generatedPath, provider);
	} finally {
		await rm(staging, { force: true }).catch(() => undefined);
	}
}

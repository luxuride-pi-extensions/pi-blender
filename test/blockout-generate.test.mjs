/**
 * `blender_blockout_generate`: the provider gate and the ComfyUI wiring.
 *
 * Two failures are worth a test here. The first is a provider that does not
 * exist being quietly treated as one that does: a caller who typed `meshy`
 * must be told it is deferred, by name, before anything touches the network or
 * the workspace. The second is a default endpoint — the tool must refuse when
 * `PI_BLENDER_COMFYUI_URL` is unset rather than inventing one, because a
 * guessed endpoint is how a key ends up in a workspace file.
 *
 * The submit-and-poll half is exercised against a local HTTP server that
 * records the requests. Blender is not involved: the bridge import is stubbed
 * out at the point where the ComfyUI output is missing, which is exactly the
 * seam that proves the wiring without a render farm.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { loadTs } from "./paths.mjs";

const { blenderBlockoutGenerate } = await loadTs("../blender/blockout.ts");

const base = { cwd: process.cwd(), workspace: "test-workspace", license: "CC0-1.0" };

async function withComfyUi(handler, run) {
	const requests = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: request.method, path: url.pathname, search: url.search, body });
			handler({ method: request.method, path: url.pathname, body }, response);
		});
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address();
	try {
		return await run(`http://127.0.0.1:${port}`, requests);
	} finally {
		await new Promise((done) => server.close(done));
	}
}

function json(response, status, payload) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(payload));
}

test("a deferred provider is refused by name, and nothing else runs", async () => {
	for (const provider of ["hunyuan", "trellis", "meshy", "tripo"]) {
		await assert.rejects(
			() => blenderBlockoutGenerate({ ...base, provider }),
			(error) => {
				assert.match(error.message, new RegExp(provider));
				assert.match(error.message, /deferred/i);
				assert.match(error.message, /"local"/);
				return true;
			},
			`provider "${provider}" must be named and refused`,
		);
	}
});

test("an unknown provider lists the ones that exist", async () => {
	await assert.rejects(
		() => blenderBlockoutGenerate({ ...base, provider: "openai" }),
		/Unknown blockout provider "openai".*"local".*"comfyui"/s,
	);
});

test("comfyui without an endpoint fails immediately and names the variable", async () => {
	const previous = process.env.PI_BLENDER_COMFYUI_URL;
	delete process.env.PI_BLENDER_COMFYUI_URL;
	try {
		await assert.rejects(
			() => blenderBlockoutGenerate({ ...base, provider: "comfyui", workflow: { "1": {} } }),
			/PI_BLENDER_COMFYUI_URL/,
		);
	} finally {
		if (previous !== undefined) process.env.PI_BLENDER_COMFYUI_URL = previous;
	}
});

test("a comfyUrl override off loopback is refused, and the env var is named as the way out", async () => {
	await assert.rejects(
		() => blenderBlockoutGenerate({ ...base, provider: "comfyui", comfyUrl: "http://10.11.12.13:8188", workflow: { "1": {} } }),
		(error) => {
			assert.match(error.message, /loopback/);
			assert.match(error.message, /10\.11\.12\.13/);
			assert.match(error.message, /PI_BLENDER_COMFYUI_URL/);
			return true;
		},
	);
	// The same address in the environment is the user's own configuration, not a
	// model-chosen host, so it passes the endpoint stage and reaches the workflow
	// check untouched.
	const previous = process.env.PI_BLENDER_COMFYUI_URL;
	process.env.PI_BLENDER_COMFYUI_URL = "http://10.11.12.13:8188";
	try {
		await assert.rejects(() => blenderBlockoutGenerate({ ...base, provider: "comfyui" }), /workflow/);
	} finally {
		if (previous === undefined) delete process.env.PI_BLENDER_COMFYUI_URL;
		else process.env.PI_BLENDER_COMFYUI_URL = previous;
	}
});

test("comfyui without a workflow says so instead of inventing a graph", async () => {
	await assert.rejects(
		() => blenderBlockoutGenerate({ ...base, provider: "comfyui", comfyUrl: "http://127.0.0.1:1" }),
		/workflow/,
	);
});

test("a blockout without a licence is refused", async () => {
	await assert.rejects(
		() => blenderBlockoutGenerate({ cwd: base.cwd, workspace: base.workspace, provider: "local", license: " " }),
		/licen[cs]e/i,
	);
});

test("async is refused for a local import, which has nothing to wait for", async () => {
	await assert.rejects(
		() => blenderBlockoutGenerate({ ...base, provider: "local", path: "/nope.glb", async: true }),
		/async/,
	);
});

test("a missing local source is reported with the path that was tried", async () => {
	await assert.rejects(
		() => blenderBlockoutGenerate({ ...base, provider: "local", path: "/nope/never.glb" }),
		/never\.glb/,
	);
});

test("comfyui posts the workflow, polls history, and reports a missing mesh output", async () => {
	await withComfyUi(
		({ path }, response) => {
			if (path === "/prompt") return json(response, 200, { prompt_id: "abc123" });
			if (path === "/history/abc123") {
				return json(response, 200, { abc123: { status: { completed: true }, outputs: { "9": { images: [] } } } });
			}
			return json(response, 404, {});
		},
		async (url, requests) => {
			await assert.rejects(
				() => blenderBlockoutGenerate({ ...base, provider: "comfyui", comfyUrl: url, workflow: { "3": { class_type: "LoadImage" } } }),
				/without a \.glb, \.gltf or \.obj output/,
			);
			assert.equal(requests[0].method, "POST");
			assert.equal(requests[0].path, "/prompt");
			assert.deepEqual(JSON.parse(requests[0].body).prompt, { "3": { class_type: "LoadImage" } });
			assert.ok(
				requests.some((request) => request.path === "/history/abc123"),
				"the tool polls the history of the prompt it queued",
			);
		},
	);
});

test("comfyui reports a rejected workflow with the server's own words", async () => {
	await withComfyUi(
		(_request, response) => json(response, 400, { error: "invalid prompt" }),
		async (url) => {
			await assert.rejects(
				() => blenderBlockoutGenerate({ ...base, provider: "comfyui", comfyUrl: url, workflow: { "1": {} } }),
				/rejected the workflow: 400.*invalid prompt/s,
			);
		},
	);
});

/**
 * Pin the machine `os.cpus()` and `os.freemem()` report, so a test can assert a
 * budget that depends on the box without depending on the box.
 *
 * WHY THIS IS A SEPARATE .cjs FILE AND NOT A LINE IN THE TEST
 *
 * blender/concurrency.ts does `import { cpus, freemem } from "node:os"`, and an
 * ESM named import is a LIVE BINDING onto the module namespace -- not a copy.
 * `import * as os from "node:os"` cannot be assigned to at all (a frozen
 * namespace), and patching `os.cpus` from ESM throws `TypeError: Cannot assign
 * to read only property 'cpus'`. So the stub has to mutate the CommonJS `os`
 * object and then hand the new functions to the ESM namespace, which is what
 * `syncBuiltinESMExports()` is for. Loading it through `createRequire` rather
 * than `import "./machine-stub.cjs"` matters for the same reason: the static
 * import would be hoisted above the statements that set up the env it reads,
 * and above any other module that imports node:os.
 *
 *     PI_TEST_CORES=12 PI_TEST_FREEMEB=... node ...
 *
 * An unset variable means "report the real machine", so a test that forgets to
 * pin one fails against the developer's own hardware rather than passing for
 * the wrong reason.
 */

const os = require("node:os");
const realCpus = os.cpus;
const realFreemem = os.freemem;

os.cpus = () =>
	process.env.PI_TEST_CORES ? new Array(Number(process.env.PI_TEST_CORES)).fill({}) : realCpus();
os.freemem = () => (process.env.PI_TEST_FREEMEM ? Number(process.env.PI_TEST_FREEMEM) : realFreemem());

require("node:module").syncBuiltinESMExports();
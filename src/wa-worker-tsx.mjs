// Source-only bootstrap for the WhatsApp worker (see wa-worker-host.ts).
//
// Running from SOURCE (the test suite, `tsx`), the worker entry is
// `wa-worker.ts`. Node 22 hands a worker the parent's `--import tsx`, Node 20
// does not — CI runs Node 20, where the worker died on "Unknown file extension
// .ts". So the TypeScript loader is registered inside the worker itself before
// the entry is imported. A build never uses this file: the host picks
// `wa-worker.js` there, and tsc does not copy an .mjs into dist.
import { register } from "tsx/esm/api";

register();
await import("./wa-worker.ts");

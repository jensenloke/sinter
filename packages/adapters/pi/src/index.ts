/**
 * @sinter/adapter-pi — pi (@earendil-works/pi-coding-agent) session v3 JSONL.
 *
 * omp is a fork of pi and the on-disk message core is shared, so the entire
 * implementation lives in `@sinter/adapter-omp` and this package is the pi
 * dialect binding. The divergences it selects (model_change shape, no title
 * slot, no header title, `--<abs-path>--` dir encoding, no sidecar) are
 * documented in `packages/adapters/omp/DIALECTS.md`.
 */

export { PI_DIALECT, PiAdapter, type AdapterOptions, type Dialect } from "@sinter/adapter-omp";
export {
  findSessionPath,
  listSessions,
  parseHead,
  parseModelChange,
  parseSessionContent,
  parseSessionFile,
  piSessionDirName,
  readSessionFile,
  readSessionFileDetailed,
  writeNativeSession,
} from "@sinter/adapter-omp";

import { PiAdapter } from "@sinter/adapter-omp";

const adapter = new PiAdapter();
export default adapter;

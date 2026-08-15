/**
 * @sinter/adapter-omp — omp (oh-my-pi) session v3 JSONL.
 *
 * Also hosts the shared implementation for the pi dialect: omp is a fork of pi
 * and the two formats share a message core. `@sinter/adapter-pi` imports from
 * here. See DIALECTS.md for the empirically-settled divergences.
 */

export { JsonlV3Adapter, OmpAdapter, PiAdapter, type AdapterOptions } from "./adapter";
export {
  OMP_DIALECT,
  PI_DIALECT,
  type Dialect,
  canonicalizePath,
  encodeLegacyAbsoluteDirName,
  encodeRelativeDirName,
  ompSessionDirName,
  parseModelChange,
  piSessionDirName,
} from "./dialect";
export { findSessionPath, listSessions, parseHead, readHead, type HeadInfo } from "./lister";
export * from "./native";
export {
  encodedDirOf,
  fileSafeIso,
  nativeIdFromFileName,
  sessionDirFor,
  sessionFileName,
  sidecarDirFor,
  storeLayout,
  type StoreLayout,
} from "./paths";
export {
  firstUserPrompt,
  mapUsage,
  parseSessionContent,
  parseSessionFile,
  readSessionFile,
  readSessionFileDetailed,
  readWithCarry,
  type CarryReadable,
  type CarrySessionRef,
  type ParsedFile,
  type ReadOptions,
  type ReadResult,
} from "./reader";
export { parseTitleSlotLine, peelTitleSlot, serializeTitleSlot, type TitleUpdate } from "./title-slot";
export { SINTER_VERSION, buildNativeBody, writeNativeSession, type NativeWriteOpts, type WriteResult } from "./writer";

import { OmpAdapter } from "./adapter";

const adapter = new OmpAdapter();
export default adapter;

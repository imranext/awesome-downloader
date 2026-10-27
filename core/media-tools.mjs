import ffmpegStatic from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Some FFmpeg builds crash while demuxing MPEG-TS, which every HLS download
// relies on. The bundled build is preferred, but a build that fails this probe
// is replaced by a working one: first a copy installed for this app, then one
// found on PATH.
const PROBE_ARGS = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-f', 'mpegts', 'pipe:1'];
const PROBE_TIMEOUT = 20 * 1000;
let resolved, problem;

function unpacked(value) {
  return value?.replace('app.asar', 'app.asar.unpacked');
}
function candidates() {
  const home = os.homedir();
  return [
    unpacked(ffmpegStatic),
    path.join(home, '.local', 'opt', 'awesome-downloader', 'ffmpeg'),
    'ffmpeg', 'ffmpeg6', 'ffmpeg5', 'ffmpeg4'
  ].filter(Boolean);
}
function usable(candidate) {
  if (!candidate) return false;
  if (path.isAbsolute(candidate) && !existsSync(candidate)) return false;
  // Writing then reading MPEG-TS exercises the exact path HLS downloads use.
  // A trivial payload is not enough: some broken builds only crash on real data.
  const encode = spawnSync(candidate, PROBE_ARGS, { timeout: PROBE_TIMEOUT, maxBuffer: 16 << 20 });
  if (encode.error || encode.signal || encode.status !== 0 || !encode.stdout?.length) return false;
  const decode = spawnSync(candidate, ['-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], { input: encode.stdout, timeout: PROBE_TIMEOUT, stdio: ['pipe', 'ignore', 'ignore'] });
  return !decode.error && !decode.signal && decode.status === 0;
}
export function ffmpegPath() {
  if (resolved) return resolved;
  const options = candidates();
  resolved = options.find(usable) || options[0];
  return resolved;
}
// Returns a user-facing reason FFmpeg cannot be used, or null when it works.
export function ffmpegProblem() {
  if (problem === undefined) {
    problem = usable(ffmpegPath()) ? null
      : 'FFmpeg cannot run on this system, so video and audio cannot be combined. Install FFmpeg (for example, sudo apt install ffmpeg) and start Awesome Downloader again.';
  }
  return problem;
}
export function spawnFfmpeg(args, options = {}) {
  const missing = ffmpegProblem();
  if (missing) throw new Error(missing);
  return spawn(ffmpegPath(), args, options);
}

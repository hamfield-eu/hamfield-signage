import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyRotation, classifyOrientation } from './orientation';
import type { MediaOrientation } from '@signage/shared';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  width: number;
  height: number;
  orientation: MediaOrientation;
  durationSeconds: number | null;
  /** Frames per second of the source video, or null if unknown. */
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  bitrate: number | null;
  hasVideoStream: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  /** e.g. "30000/1001" or "60/1". */
  avg_frame_rate?: string;
  r_frame_rate?: string;
  side_data_list?: Array<{ rotation?: number }>;
  tags?: Record<string, string>;
}

/** Parses an ffprobe rational frame-rate string ("60/1", "30000/1001") to fps. */
function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const [num, den] = raw.split('/');
  const n = Number(num);
  const d = den == null ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return null;
  return n / d;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    format_name?: string;
    bit_rate?: string;
  };
}

export function ffprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/** Runs ffprobe and returns normalized metadata (rotation applied). */
export async function probeMediaFile(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    ffprobePath(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  return interpretProbeOutput(parsed);
}

/** Pure interpretation of ffprobe JSON; exported separately for testing. */
export function interpretProbeOutput(parsed: FfprobeOutput): ProbeResult {
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error('No decodable video/image stream found');
  }

  let rotation = 0;
  const sideData = videoStream.side_data_list?.find((d) => typeof d.rotation === 'number');
  if (sideData?.rotation != null) {
    rotation = sideData.rotation;
  } else if (videoStream.tags?.rotate) {
    rotation = Number(videoStream.tags.rotate) || 0;
  }

  const { width, height } = applyRotation(videoStream.width, videoStream.height, rotation);

  let duration: number | null = null;
  const rawDuration = parsed.format?.duration ?? videoStream.duration;
  if (rawDuration != null) {
    const d = Number(rawDuration);
    if (Number.isFinite(d) && d > 0) duration = d;
  }

  return {
    width,
    height,
    orientation: classifyOrientation(width, height),
    durationSeconds: duration,
    frameRate:
      parseFrameRate(videoStream.avg_frame_rate) ?? parseFrameRate(videoStream.r_frame_rate),
    videoCodec: videoStream.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    container: parsed.format?.format_name ?? null,
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    hasVideoStream: true,
  };
}

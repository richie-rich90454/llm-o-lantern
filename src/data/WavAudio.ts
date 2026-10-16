/**
 * Shared PCM WAV helpers. Used by the browser (encoding captured microphone
 * audio before transcription) and by the backend (decoding synthesized audio
 * before timing alignment).
 */

export class WavData {
  readonly sampleRate: number;
  readonly channels: number;
  readonly samples: Float32Array;
  readonly durationSeconds: number;

  constructor(sampleRate: number, channels: number, samples: Float32Array) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.samples = samples;
    this.durationSeconds = samples.length / sampleRate;
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index]);
  }
  return text;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function decodeWav(bytes: Uint8Array): WavData {
  if (bytes.length < 44) {
    throw new Error("WAV data is too short to contain a header");
  }
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Audio data is not a RIFF/WAVE file");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      if (chunkSize < 16 || body + 16 > bytes.length) {
        throw new Error("WAV fmt chunk is malformed");
      }
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (audioFormat === 0xfffe && chunkSize >= 26 && body + 26 <= bytes.length) {
        audioFormat = view.getUint16(body + 24, true);
      }
    } else if (chunkId === "data") {
      dataOffset = body;
      dataLength = Math.min(chunkSize, bytes.length - body);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (channels !== 1 && channels !== 2) {
    throw new Error(`Unsupported WAV channel count: ${channels} (only mono and stereo are supported)`);
  }
  if (sampleRate <= 0 || dataOffset < 0 || dataLength <= 0) {
    throw new Error("WAV file is missing its format or data chunk");
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  if (frameCount <= 0) {
    throw new Error("WAV data chunk contains no complete sample frames");
  }

  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const position = dataOffset + (frame * channels + channel) * bytesPerSample;
      mixed += readSample(view, position, audioFormat, bitsPerSample);
    }
    samples[frame] = mixed / channels;
  }

  return new WavData(sampleRate, channels, samples);
}

function readSample(view: DataView, position: number, audioFormat: number, bitsPerSample: number): number {
  if (audioFormat === 1 && bitsPerSample === 8) {
    return (view.getUint8(position) - 128) / 128;
  }
  if (audioFormat === 1 && bitsPerSample === 16) {
    return view.getInt16(position, true) / 32768;
  }
  if (audioFormat === 1 && bitsPerSample === 24) {
    const low = view.getUint8(position);
    const middle = view.getUint8(position + 1);
    const high = view.getInt8(position + 2);
    return ((high << 16) | (middle << 8) | low) / 8388608;
  }
  if (audioFormat === 1 && bitsPerSample === 32) {
    return view.getInt32(position, true) / 2147483648;
  }
  if (audioFormat === 3 && bitsPerSample === 32) {
    return view.getFloat32(position, true);
  }
  throw new Error(`Unsupported WAV encoding (format ${audioFormat}, ${bitsPerSample}-bit)`);
}

export function encodeWavMono(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`encodeWavMono needs a positive sample rate, received ${sampleRate}`);
  }
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}

export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) {
    throw new Error(`resampleLinear needs positive sample rates, received ${fromRate} -> ${toRate}`);
  }
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const lower = Math.floor(position);
    const fraction = position - lower;
    const upper = Math.min(lower + 1, samples.length - 1);
    output[index] = samples[lower] * (1 - fraction) + samples[upper] * fraction;
  }
  return output;
}

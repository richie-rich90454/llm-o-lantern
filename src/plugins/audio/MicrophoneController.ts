import type { ApplicationLogger } from "../../core/ApplicationLogger";

const RING_BUFFER_SECONDS = 20;
const PROCESSOR_BUFFER_SIZE = 4096;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class MicrophoneController {
    readonly id = "microphone.browser";
    readonly version = "1.0.0";
    readonly category = "microphone";

    private readonly audioContext: AudioContext;
    private readonly logger: ApplicationLogger;
    private readonly capacity: number;
    private readonly ring: Float32Array;
    private writeIndex = 0;
    private totalSamples = 0;
    private frameListener: ((frame: Float32Array) => void) | null = null;
    private stream: MediaStream | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private processorNode: ScriptProcessorNode | null = null;
    private zeroGainNode: GainNode | null = null;
    private capturing = false;

    constructor(audioContext: AudioContext, logger: ApplicationLogger) {
        this.audioContext = audioContext;
        this.logger = logger;
        this.capacity = Math.max(1, Math.round(audioContext.sampleRate * RING_BUFFER_SECONDS));
        this.ring = new Float32Array(this.capacity);
    }

    async start(): Promise<void> {
        if (this.capturing) {
            return;
        }

        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
        } catch (error) {
            if (
                typeof error === "object" &&
                error !== null &&
                "name" in error &&
                error.name === "NotAllowedError"
            ) {
                throw new Error(
                    "Microphone permission was denied. Allow the microphone for this page and reload.",
                );
            }
            throw new Error(`Microphone could not be opened: ${errorMessage(error)}`);
        }

        let sourceNode: MediaStreamAudioSourceNode;
        let processorNode: ScriptProcessorNode;
        let zeroGainNode: GainNode;
        try {
            sourceNode = this.audioContext.createMediaStreamSource(stream);
            // Deprecated in favour of AudioWorklet, but universally supported and it
            // needs no worklet module; AudioWorklet is the upgrade path.
            processorNode = this.audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
            zeroGainNode = this.audioContext.createGain();
        } catch (error) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
            throw new Error(`Microphone could not be opened: ${errorMessage(error)}`);
        }

        zeroGainNode.gain.value = 0;
        processorNode.onaudioprocess = (event: AudioProcessingEvent): void => {
            // The input buffer is reused on the next callback, so detach a copy.
            const frame = event.inputBuffer.getChannelData(0).slice();
            this.writeFrame(frame);
            const listener = this.frameListener;
            if (listener) {
                listener(frame);
            }
        };
        sourceNode.connect(processorNode);
        // Zero gain keeps the processor pulling in every browser without playing
        // the microphone back through the speakers.
        processorNode.connect(zeroGainNode);
        zeroGainNode.connect(this.audioContext.destination);

        this.stream = stream;
        this.sourceNode = sourceNode;
        this.processorNode = processorNode;
        this.zeroGainNode = zeroGainNode;
        this.capturing = true;
        this.logger.debug("Microphone capture started", {
            sampleRate: this.audioContext.sampleRate,
        });
    }

    stop(): void {
        const processor = this.processorNode;
        if (processor) {
            processor.onaudioprocess = null;
            processor.disconnect();
            this.logger.debug("Microphone capture stopped");
        }
        const sourceNode = this.sourceNode;
        if (sourceNode) {
            sourceNode.disconnect();
        }
        const zeroGain = this.zeroGainNode;
        if (zeroGain) {
            zeroGain.disconnect();
        }
        const stream = this.stream;
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }
        this.sourceNode = null;
        this.processorNode = null;
        this.zeroGainNode = null;
        this.stream = null;
        this.capturing = false;
    }

    isCapturing(): boolean {
        return this.capturing;
    }

    setFrameListener(listener: ((frame: Float32Array) => void) | null): void {
        this.frameListener = listener;
    }

    getSampleRate(): number {
        return this.audioContext.sampleRate;
    }

    getCapturedSampleCount(): number {
        return this.totalSamples;
    }

    getSamplesRange(startIndex: number, endIndex: number): Float32Array {
        const earliest = Math.max(0, this.totalSamples - this.capacity);
        const start = Math.max(startIndex, earliest);
        const end = Math.min(endIndex, this.totalSamples);
        if (end <= start) {
            return new Float32Array(0);
        }
        const output = new Float32Array(end - start);
        for (let index = 0; index < output.length; index += 1) {
            output[index] = this.ring[(start + index) % this.capacity];
        }
        return output;
    }

    clearBufferedAudio(): void {
        this.ring.fill(0);
    }

    dispose(): void {
        this.stop();
    }

    private writeFrame(frame: Float32Array): void {
        let index = this.writeIndex;
        for (let sample = 0; sample < frame.length; sample += 1) {
            this.ring[index] = frame[sample];
            index += 1;
            if (index >= this.capacity) {
                index = 0;
            }
        }
        this.writeIndex = index;
        this.totalSamples += frame.length;
    }
}

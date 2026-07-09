import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── System Audio Sampler ────────────────────────────────────────
//
// Captures the Mac's system-audio loudness via ScreenCaptureKit. On first use it
// compiles a tiny Swift helper to a temp dir, then runs it and parses the streamed
// RMS/dB to expose a 0..1 amplitude. macOS only; a no-op elsewhere.

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface AudioSample {
	playing: boolean;
	amplitude: number;
}

const SYSTEM_AUDIO_SWIFT_SOURCE = String.raw`import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreAudio

final class AudioMeter: NSObject, SCStreamOutput {
    private var lastPrint = Date.distantPast
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let fmt = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmt) else { return }
        let asbd = asbdPtr.pointee
        var needed = 0
        var blockBuffer: CMBlockBuffer?
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &needed,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr, needed > 0 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let abl = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: abl,
            bufferListSize: needed,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }
        let flags = asbd.mFormatFlags
        let isFloat = (flags & kAudioFormatFlagIsFloat) != 0
        let bytesPerSample = Int(asbd.mBitsPerChannel / 8)
        var sum: Double = 0
        var count = 0
        for buffer in UnsafeMutableAudioBufferListPointer(abl) {
            guard let data = buffer.mData else { continue }
            let byteCount = Int(buffer.mDataByteSize)
            if isFloat && bytesPerSample == 4 {
                let n = byteCount / MemoryLayout<Float>.size
                let p = data.bindMemory(to: Float.self, capacity: n)
                for i in 0..<n { let v = Double(p[i]); sum += v * v }
                count += n
            } else if bytesPerSample == 2 {
                let n = byteCount / MemoryLayout<Int16>.size
                let p = data.bindMemory(to: Int16.self, capacity: n)
                for i in 0..<n { let v = Double(p[i]) / 32768.0; sum += v * v }
                count += n
            }
        }
        guard count > 0 else { return }
        let now = Date()
        if now.timeIntervalSince(lastPrint) > 0.10 {
            lastPrint = now
            let rms = sqrt(sum / Double(count))
            let db = 20.0 * log10(max(rms, 0.000001))
            let payload: [String: Any] = ["rms": rms, "db": db]
            if let data = try? JSONSerialization.data(withJSONObject: payload), let line = String(data: data, encoding: .utf8) {
                print(line)
                fflush(stdout)
            }
        }
    }
}

@main
struct Main {
    static func main() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { return }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.width = 2
        config.height = 2
        let meter = AudioMeter()
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(meter, type: .audio, sampleHandlerQueue: DispatchQueue(label: "pi.system-audio.meter"))
        try await stream.startCapture()
        while !Task.isCancelled {
            try await Task.sleep(nanoseconds: 60_000_000_000)
        }
    }
}
`;

let systemAudioBinaryPromise: Promise<string> | undefined;

function dbToAmplitude(db: number): number {
	if (!Number.isFinite(db) || db <= -90) return 0;
	return clamp((db + 60) / 42, 0, 1);
}

function runStandalone(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ stdout, stderr: stderr || error.message, code: 1 });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 1 });
		});
	});
}

async function ensureSystemAudioBinary(): Promise<string> {
	if (!systemAudioBinaryPromise) {
		systemAudioBinaryPromise = (async () => {
			const hash = createHash("sha256").update(SYSTEM_AUDIO_SWIFT_SOURCE).digest("hex").slice(0, 12);
			const dir = join(tmpdir(), "pi-system-audio");
			const sourcePath = join(dir, `system-audio-${hash}.swift`);
			const binaryPath = join(dir, `system-audio-${hash}`);
			if (existsSync(binaryPath)) return binaryPath;
			await mkdir(dir, { recursive: true });
			await writeFile(sourcePath, SYSTEM_AUDIO_SWIFT_SOURCE, "utf8");
			const result = await runStandalone("swiftc", ["-parse-as-library", sourcePath, "-o", binaryPath], 30_000);
			if (result.code !== 0) throw new Error(result.stderr.trim() || "swiftc failed");
			return binaryPath;
		})();
	}
	return systemAudioBinaryPromise;
}

export class SystemAudioSampler {
	private child?: ChildProcess;
	private starting = false;
	private stdoutBuffer = "";
	private cached: AudioSample = { playing: false, amplitude: 0 };
	private lastDb?: number;
	private lastError?: string;

	start(): void {
		if (this.child || this.starting || process.platform !== "darwin") return;
		this.starting = true;
		void this.startAsync();
	}

	stop(): void {
		this.child?.kill("SIGTERM");
		this.child = undefined;
		this.starting = false;
		this.stdoutBuffer = "";
		this.cached = { playing: false, amplitude: 0 };
		this.lastDb = undefined;
	}

	amplitude(): number {
		return this.cached.amplitude;
	}

	// Raw loudness in dB (−120 when there's no signal). For consumers that want to do
	// their own gain mapping — the static amplitude() crushes real, compressed audio.
	db(): number {
		return this.lastDb ?? -120;
	}

	status(): string {
		if (this.child) return this.lastDb === undefined ? "system audio starting" : `${this.lastDb.toFixed(1)} dB`;
		if (this.starting) return "system audio compiling";
		return this.lastError ? `system audio unavailable: ${this.lastError}` : "system audio idle";
	}

	private async startAsync(): Promise<void> {
		try {
			const binary = await ensureSystemAudioBinary();
			if (!this.starting) return;
			const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
			this.child = child;
			this.starting = false;
			child.stdout.on("data", (chunk) => this.handleStdout(String(chunk)));
			child.stderr.on("data", (chunk) => {
				const text = String(chunk).trim();
				if (text) this.lastError = text;
			});
			child.on("error", (error) => {
				this.lastError = error.message;
				this.stop();
			});
			child.on("close", (code) => {
				if (this.child === child) this.child = undefined;
				this.cached = { playing: false, amplitude: 0 };
				if (code && !this.lastError) this.lastError = `helper exited ${code}`;
			});
		} catch (error) {
			this.starting = false;
			this.lastError = error instanceof Error ? error.message : String(error);
		}
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			try {
				const data = JSON.parse(line) as { db?: unknown };
				const db = typeof data.db === "number" ? data.db : -120;
				this.lastDb = db;
				this.cached = { playing: db > -80, amplitude: dbToAmplitude(db) };
			} catch {
				// Ignore partial/non-JSON helper output.
			}
		}
	}
}

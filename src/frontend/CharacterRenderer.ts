import * as THREE from "three";
import { SceneController } from "./SceneController";

const MAX_PIXEL_RATIO = 2;
const MAX_FRAME_SECONDS = 0.1;
const FIRST_FRAME_SECONDS = 1 / 60;

export class CharacterRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly sceneController: SceneController;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly frameCallbacks = new Set<(dtSeconds: number) => void>();
  private readonly callbackScratch: ((dtSeconds: number) => void)[] = [];
  private frameHandle: number | null = null;
  private lastTimestampMs: number | null = null;

  constructor(container: HTMLElement, sceneController: SceneController) {
    this.container = container;
    this.sceneController = sceneController;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    container.appendChild(this.renderer.domElement);

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(container);
    this.handleResize();
  }

  start(): void {
    if (this.frameHandle !== null) {
      return;
    }
    this.lastTimestampMs = null;
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.lastTimestampMs = null;
  }

  isRunning(): boolean {
    return this.frameHandle !== null;
  }

  onFrame(callback: (dtSeconds: number) => void): () => void {
    this.frameCallbacks.add(callback);
    return () => {
      this.frameCallbacks.delete(callback);
    };
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.frameCallbacks.clear();
    this.callbackScratch.length = 0;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly tick = (timestampMs: number): void => {
    const dtSeconds =
      this.lastTimestampMs === null
        ? FIRST_FRAME_SECONDS
        : Math.min((timestampMs - this.lastTimestampMs) / 1000, MAX_FRAME_SECONDS);
    this.lastTimestampMs = timestampMs;

    // Reschedule before invoking callbacks so a callback that calls stop()
    // cancels the pending frame cleanly.
    this.frameHandle = requestAnimationFrame(this.tick);

    this.sceneController.update(dtSeconds);

    const callbacks = this.callbackScratch;
    callbacks.length = 0;
    for (const callback of this.frameCallbacks) {
      callbacks.push(callback);
    }
    for (const callback of callbacks) {
      callback(dtSeconds);
    }

    this.renderer.render(this.sceneController.getScene(), this.sceneController.getCamera());
  };

  private handleResize(): void {
    const width = this.container.clientWidth > 0 ? this.container.clientWidth : window.innerWidth;
    const height = this.container.clientHeight > 0 ? this.container.clientHeight : window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.sceneController.setViewportSize(width, height);
  }
}

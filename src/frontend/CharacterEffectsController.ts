import * as THREE from "three";
import type { CharacterState, FacialState } from "../data/CharacterState";

const TAU = Math.PI * 2;
const FACE_POINT = { x: 0, y: -0.15, z: 0.9 };
const MOUTH_POINT = { x: 0, y: -0.34, z: 0.85 };
const OPACITY_RATE = 3.2;

type ParticleSystem = {
    points: THREE.Points;
    material: THREE.PointsMaterial;
    positions: Float32Array;
    colors: Float32Array;
    phases: Float32Array;
    count: number;
    opacity: number;
    targetOpacity: number;
};

/** Deterministic pseudo-random so the mood is stable across sessions. */
function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function makeSystem(
    count: number,
    size: number,
    baseColor: THREE.Color,
    seed: number,
): ParticleSystem {
    const random = makeRandom(seed);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
        phases[index] = random() * TAU;
        colors[index * 3] = baseColor.r;
        colors[index * 3 + 1] = baseColor.g;
        colors[index * 3 + 2] = baseColor.b;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
        size,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    return {
        points,
        material,
        positions,
        colors,
        phases,
        count,
        opacity: 0,
        targetOpacity: 0,
    };
}

/**
 * The pumpkin's stage magic: drifting fireflies at rest, golden soul-motes
 * that flow into its face while it listens, embers that puff from its mouth
 * while it speaks (emission follows the mouth), slow orbiting sparks while it
 * thinks, and a radial burst when it is interrupted. Everything is a
 * deterministic THREE.Points system updated in place, so the frame loop never
 * allocates.
 */
export class CharacterEffectsController {
    private readonly root = new THREE.Group();
    private readonly motes: ParticleSystem;
    private readonly intake: ParticleSystem;
    private readonly embers: ParticleSystem;
    private readonly orbit: ParticleSystem;
    private readonly burst: ParticleSystem;

    private readonly moteOrigins: Float32Array;
    private readonly emberSeeds: Float32Array;
    private readonly burstVelocities: Float32Array;
    private readonly warmColor = new THREE.Color(0xffa640);
    private readonly hotColor = new THREE.Color(0xffe6a0);
    private readonly coolColor = new THREE.Color(0x8fd8ff);
    private readonly scratchColor = new THREE.Color();
    private readonly scratchColorB = new THREE.Color();

    private state: CharacterState = "IDLE";
    private previousState: CharacterState = "IDLE";
    private burstAge = Number.POSITIVE_INFINITY;
    private elapsed = 0;

    constructor() {
        this.motes = makeSystem(44, 0.035, new THREE.Color(0xffb45e), 11);
        this.intake = makeSystem(72, 0.045, new THREE.Color(0x9fe3ff), 23);
        this.embers = makeSystem(96, 0.05, new THREE.Color(0xff9a2a), 37);
        this.orbit = makeSystem(34, 0.042, new THREE.Color(0xffd66b), 51);
        this.burst = makeSystem(64, 0.065, new THREE.Color(0xfff1c9), 77);

        this.root.add(
            this.motes.points,
            this.intake.points,
            this.embers.points,
            this.orbit.points,
            this.burst.points,
        );

        const moteRandom = makeRandom(101);
        this.moteOrigins = new Float32Array(this.motes.count * 3);
        for (let index = 0; index < this.motes.count; index += 1) {
            const radius = 0.9 + moteRandom() * 1.5;
            const angle = moteRandom() * TAU;
            this.moteOrigins[index * 3] = Math.cos(angle) * radius;
            this.moteOrigins[index * 3 + 1] = -0.9 + moteRandom() * 1.9;
            this.moteOrigins[index * 3 + 2] = Math.sin(angle) * radius;
        }

        const emberRandom = makeRandom(202);
        this.emberSeeds = new Float32Array(this.embers.count);
        for (let index = 0; index < this.embers.count; index += 1) {
            this.emberSeeds[index] = emberRandom();
        }

        const burstRandom = makeRandom(303);
        this.burstVelocities = new Float32Array(this.burst.count * 3);
        for (let index = 0; index < this.burst.count; index += 1) {
            const theta = burstRandom() * TAU;
            const phi = Math.acos(2 * burstRandom() - 1);
            const speed = 1.1 + burstRandom() * 1.6;
            this.burstVelocities[index * 3] = Math.sin(phi) * Math.cos(theta) * speed;
            this.burstVelocities[index * 3 + 1] = Math.cos(phi) * speed * 0.8;
            this.burstVelocities[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
        }
    }

    getRoot(): THREE.Group {
        return this.root;
    }

    setCharacterState(state: CharacterState): void {
        if (state === this.state) {
            return;
        }
        this.previousState = this.state;
        this.state = state;
        if (state === "INTERRUPTED" || state === "RECOVERING") {
            this.burstAge = 0;
        }
    }

    update(dtSeconds: number, facialState: FacialState): void {
        const dt = Math.min(dtSeconds, 0.1);
        this.elapsed += dt;
        if (this.burstAge < Number.POSITIVE_INFINITY) {
            this.burstAge += dt;
        }

        const mouthActivity = Math.max(0, 1 - facialState.visemeWeights[0]);
        const listening = this.state === "LISTENING";
        const thinking = this.state === "THINKING" || this.state === "PREPARING_SPEECH";
        const speaking = this.state === "SPEAKING" || this.state === "PREPARING_SPEECH";

        this.motes.targetOpacity = 0.55;
        this.intake.targetOpacity = listening ? 0.95 : 0;
        this.embers.targetOpacity = speaking ? 0.35 + 0.55 * mouthActivity : 0;
        this.orbit.targetOpacity = thinking ? 0.8 : 0;
        const burstLife = this.burstAge / 1.1;
        this.burst.targetOpacity = burstLife < 1 ? 0.95 * (1 - burstLife) : 0;

        this.updateMotes(dt);
        this.updateIntake(dt, listening);
        this.updateEmbers(dt, speaking, mouthActivity);
        this.updateOrbit(dt);
        this.updateBurst();

        for (const system of [this.motes, this.intake, this.embers, this.orbit, this.burst]) {
            system.opacity +=
                (system.targetOpacity - system.opacity) * Math.min(1, dt * OPACITY_RATE);
            system.material.opacity = system.opacity;
            system.points.visible = system.opacity > 0.02;
            (system.points.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate =
                true;
        }
    }

    dispose(): void {
        for (const system of [this.motes, this.intake, this.embers, this.orbit, this.burst]) {
            system.points.geometry.dispose();
            system.material.dispose();
        }
        this.root.clear();
    }

    private updateMotes(dt: number): void {
        const { positions, colors, phases, count } = this.motes;
        for (let index = 0; index < count; index += 1) {
            const phase = phases[index];
            const baseX = this.moteOrigins[index * 3];
            const baseY = this.moteOrigins[index * 3 + 1];
            const baseZ = this.moteOrigins[index * 3 + 2];
            positions[index * 3] = baseX + Math.sin(this.elapsed * 0.4 + phase) * 0.16;
            positions[index * 3 + 1] =
                baseY +
                Math.sin(this.elapsed * 0.27 + phase * 1.7) * 0.12 +
                Math.sin(this.elapsed * 0.11) * 0.05;
            positions[index * 3 + 2] = baseZ + Math.cos(this.elapsed * 0.35 + phase * 0.6) * 0.16;
            const twinkle = 0.55 + 0.45 * Math.sin(this.elapsed * 2.3 + phase * 3.1);
            this.scratchColor.copy(this.warmColor).multiplyScalar(twinkle);
            colors[index * 3] = this.scratchColor.r;
            colors[index * 3 + 1] = this.scratchColor.g;
            colors[index * 3 + 2] = this.scratchColor.b;
        }
        (this.motes.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate =
            true;
    }

    private updateIntake(dt: number, active: boolean): void {
        const { positions, colors, phases, count } = this.intake;
        if (!active && this.intake.opacity < 0.02) {
            return;
        }
        for (let index = 0; index < count; index += 1) {
            const phase = phases[index];
            const speed = 0.5 + (phase % 1) * 0.35;
            let x = positions[index * 3];
            let y = positions[index * 3 + 1];
            let z = positions[index * 3 + 2];
            if (z === 0 && x === 0 && y === 0) {
                // spawn on a front arc in front of the face
                const spawnAngle = (phase / TAU) * 1.8 - 0.9;
                x = Math.sin(spawnAngle) * 1.5;
                y = -0.4 + ((phase * 7.13) % 1) * 0.9;
                z = Math.cos(spawnAngle) * 1.5 + 0.4;
            }
            const dx = FACE_POINT.x - x;
            const dy = FACE_POINT.y - y;
            const dz = FACE_POINT.z - z;
            const distance = Math.hypot(dx, dy, dz);
            if (distance < 0.18) {
                const spawnAngle = ((phase + this.elapsed * 0.13) % TAU) * 0.28 - 0.9;
                x = Math.sin(spawnAngle) * 1.6;
                y = -0.45 + ((phase * 7.13 + this.elapsed * 0.3) % 1) * 0.9;
                z = Math.cos(spawnAngle) * 1.6 + 0.3;
            } else {
                const step = (speed * dt) / distance;
                const swirl = Math.sin(this.elapsed * 2 + phase * 5) * 0.35 * dt;
                x += dx * step + swirl;
                y += dy * step + Math.cos(this.elapsed * 1.7 + phase * 3) * 0.2 * dt;
                z += dz * step;
            }
            positions[index * 3] = x;
            positions[index * 3 + 1] = y;
            positions[index * 3 + 2] = z;
            const glow = 0.6 + 0.4 * Math.sin(this.elapsed * 3 + phase * 4);
            colors[index * 3] = this.coolColor.r * glow;
            colors[index * 3 + 1] = this.coolColor.g * glow;
            colors[index * 3 + 2] = this.coolColor.b * glow;
        }
        (
            this.intake.points.geometry.getAttribute("position") as THREE.BufferAttribute
        ).needsUpdate = true;
    }

    private updateEmbers(dt: number, active: boolean, mouthActivity: number): void {
        const { positions, colors, count } = this.embers;
        if (!active && this.embers.opacity < 0.02) {
            return;
        }
        for (let index = 0; index < count; index += 1) {
            const seed = this.emberSeeds[index];
            let x = positions[index * 3];
            let y = positions[index * 3 + 1];
            let z = positions[index * 3 + 2];
            if (z === 0 && x === 0 && y === 0) {
                x = MOUTH_POINT.x + (seed - 0.5) * 0.3;
                y = MOUTH_POINT.y + (((seed * 5.7) % 1) - 0.5) * 0.14;
                z = MOUTH_POINT.z;
            }
            const life = (this.elapsed * (0.9 + seed) + seed * 10) % 1;
            x += Math.sin(this.elapsed * 1.3 + seed * 9) * 0.35 * dt;
            y += (0.25 + seed * 0.5 + mouthActivity * 0.55) * dt;
            z += 0.22 * dt;
            if (life > 0.94 || y > 1.1) {
                x = MOUTH_POINT.x + Math.sin(this.elapsed * 7 + seed * 30) * 0.5 * 0.24;
                y = MOUTH_POINT.y + Math.cos(this.elapsed * 5 + seed * 40) * 0.5 * 0.08;
                z = MOUTH_POINT.z;
            }
            positions[index * 3] = x;
            positions[index * 3 + 1] = y;
            positions[index * 3 + 2] = z;
            this.scratchColorB
                .copy(this.warmColor)
                .lerp(this.hotColor, Math.min(1, (y + 0.4) * 1.4));
            const fade = Math.max(0.15, 1 - (y + 0.4));
            colors[index * 3] = this.scratchColorB.r * fade;
            colors[index * 3 + 1] = this.scratchColorB.g * fade;
            colors[index * 3 + 2] = this.scratchColorB.b * fade;
        }
        (
            this.embers.points.geometry.getAttribute("position") as THREE.BufferAttribute
        ).needsUpdate = true;
    }

    private updateOrbit(dt: number): void {
        const { positions, colors, phases, count } = this.orbit;
        for (let index = 0; index < count; index += 1) {
            const phase = phases[index];
            const speed = 0.7 + (phase % 1) * 0.9;
            const angle = this.elapsed * speed + phase * 4;
            const radius = 0.4 + 0.18 * Math.sin(this.elapsed * 0.6 + phase * 2);
            const x = Math.cos(angle) * radius;
            const z = Math.sin(angle) * radius;
            const y = 0.72 + Math.sin(this.elapsed * 1.1 + phase * 3) * 0.1;
            positions[index * 3] = x;
            positions[index * 3 + 1] = y;
            positions[index * 3 + 2] = z;
            const pulse = 0.6 + 0.4 * Math.sin(this.elapsed * 4 + phase * 6);
            colors[index * 3] = this.hotColor.r * pulse;
            colors[index * 3 + 1] = this.hotColor.g * pulse;
            colors[index * 3 + 2] = this.hotColor.b * pulse;
        }
        (this.orbit.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate =
            true;
    }

    private updateBurst(): void {
        const { positions, count } = this.burst;
        if (this.burst.targetOpacity <= 0 && this.burst.opacity <= 0.02) {
            return;
        }
        const age = this.burstAge;
        for (let index = 0; index < count; index += 1) {
            const base = index * 3;
            positions[base] = this.burstVelocities[base] * age;
            positions[base + 1] = 0.1 + this.burstVelocities[base + 1] * age - 0.5 * age * age;
            positions[base + 2] = this.burstVelocities[base + 2] * age;
        }
        (this.burst.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate =
            true;
    }
}

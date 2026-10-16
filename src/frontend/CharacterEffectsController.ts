import * as THREE from "three";
import type { CharacterState, FacialState } from "../data/CharacterState";

const TAU = Math.PI * 2;
// Anchors sit just proud of the carved surface (radius ~1.0 at the face,
// patch ~1.0) so particles are visible instead of buried in the body.
const FACE = { x: 0, y: -0.15, z: 1.1 };
const MOUTH = { x: 0, y: -0.32, z: 1.06 };
const DUST_Y_FLOOR = -1.0;
const OPACITY_RATE = 3.4;
const SHOCKWAVE_SECONDS = 0.7;

const POINT_VERTEX_SHADER = `
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (170.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
}`;

const POINT_FRAGMENT_SHADER = `
uniform float uOpacity;
varying vec3 vColor;
void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    float halo = smoothstep(0.5, 0.06, r);
    float core = smoothstep(0.18, 0.0, r);
    gl_FragColor = vec4(vColor * (1.0 + core * 0.8), (halo * 0.85 + core * 0.35) * uOpacity);
}`;

/**
 * Fresnel rim glow is intentionally NOT used: an enclosing shell around the
 * pumpkin read as a strange bubble in practice. Presence comes from the
 * particles, the face lights, and the palette instead.
 */

type SoftSystem = {
    points: THREE.Points;
    material: THREE.ShaderMaterial;
    positions: Float32Array;
    colors: Float32Array;
    sizes: Float32Array;
    seeds: Float32Array;
    count: number;
    opacity: number;
    targetOpacity: number;
};

function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function makeSoftMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        vertexShader: POINT_VERTEX_SHADER,
        fragmentShader: POINT_FRAGMENT_SHADER,
        uniforms: { uOpacity: { value: 0 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
}

function makeSystem(count: number, sizeRange: [number, number], seed: number): SoftSystem {
    const random = makeRandom(seed);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const seeds = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
        seeds[index] = random();
        sizes[index] = sizeRange[0] + random() * (sizeRange[1] - sizeRange[0]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
        "aColor",
        new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
        "aSize",
        new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage),
    );
    const points = new THREE.Points(geometry, makeSoftMaterial());
    points.frustumCulled = false;
    return {
        points,
        material: points.material as THREE.ShaderMaterial,
        positions,
        colors,
        sizes,
        seeds,
        count,
        opacity: 0,
        targetOpacity: 0,
    };
}

/** A faint echo of another system, drawn one step behind it for motion trails. */
function makeTrail(source: SoftSystem, scale: number): SoftSystem {
    const count = source.count;
    const trail = makeSystem(count, [0.05, 0.1], 1);
    for (let index = 0; index < count; index += 1) {
        trail.seeds[index] = source.seeds[index];
        trail.sizes[index] = source.sizes[index] * scale;
    }
    return trail;
}

type AccentKind = "none" | "fountain" | "pulse" | "smoke";

/**
 * The pumpkin's stage magic, choreographed for elegance: a breathing fresnel
 * aura, blinking fireflies, comet-trailed soul-motes spiraling into the face
 * while LISTENING, mouth-driven embers with fire wisps while SPEAKING, twin
 * thought rings and a rising idea-spark while THINKING, and twin shockwave
 * rings with an accent fountain on INTERRUPTED or strong emotions. All motion
 * derives from one shared clock with irrational phase offsets, so nothing
 * ever visibly loops, and the whole palette glides between state colors.
 */
export class CharacterEffectsController {
    private readonly root = new THREE.Group();
    private readonly motes: SoftSystem;
    private readonly intake: SoftSystem;
    private readonly intakeTrail: SoftSystem;
    private readonly embers: SoftSystem;
    private readonly emberTrail: SoftSystem;
    private readonly wisps: SoftSystem;
    private readonly orbit: SoftSystem;
    private readonly ideaSpark: SoftSystem;
    private readonly dust: SoftSystem;
    private readonly burst: SoftSystem;
    private readonly fountain: SoftSystem;
    private readonly ringNear: THREE.Mesh;
    private readonly ringFar: THREE.Mesh;
    private readonly ringMaterials: [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial];

    private readonly moteOrigins: Float32Array;
    private readonly intakeAngle: Float32Array;
    private readonly intakeRadius: Float32Array;
    private readonly intakeHeight: Float32Array;
    private readonly intakeSpin: Float32Array;
    private readonly intakeCycles: Float32Array;
    private readonly emberAge: Float32Array;
    private readonly emberVelocity: Float32Array;
    private readonly wispSeeds: Float32Array;
    private readonly wispAge: Float32Array;
    private readonly dustOrigins: Float32Array;
    private readonly burstVelocity: Float32Array;
    private readonly fountainVelocity: Float32Array;

    private readonly amber = new THREE.Color(0xffb45e);
    private readonly ghost = new THREE.Color(0x9fe3ff);
    private readonly taupe = new THREE.Color(0x6f5a4a);
    private readonly emberHot = new THREE.Color(0xfff3c4);
    private readonly emberDeep = new THREE.Color(0xc23a08);
    private readonly palettes: Record<CharacterState, THREE.Color> = {
        IDLE: new THREE.Color(0xffb45e),
        LISTENING: new THREE.Color(0x9fe3ff),
        THINKING: new THREE.Color(0xffd166),
        PREPARING_SPEECH: new THREE.Color(0xffd166),
        SPEAKING: new THREE.Color(0xff9a2a),
        INTERRUPTED: new THREE.Color(0xfff1c9),
        RECOVERING: new THREE.Color(0x8fa8c8),
    };
    private readonly paletteColor = new THREE.Color(0xffb45e);
    private readonly scratch = new THREE.Color();
    private readonly scratchB = new THREE.Color();

    private state: CharacterState = "IDLE";
    private burstAge = Number.POSITIVE_INFINITY;
    private accentKind: AccentKind = "none";
    private accentAge = Number.POSITIVE_INFINITY;
    private elapsed = 0;

    constructor() {
        this.motes = makeSystem(64, [0.1, 0.24], 11);
        this.intake = makeSystem(96, [0.09, 0.2], 23);
        this.intakeTrail = makeTrail(this.intake, 0.55);
        this.embers = makeSystem(120, [0.1, 0.3], 37);
        this.emberTrail = makeTrail(this.embers, 0.5);
        this.wisps = makeSystem(10, [0.22, 0.4], 41);
        this.orbit = makeSystem(44, [0.09, 0.16], 51);
        this.ideaSpark = makeSystem(1, [0.22, 0.22], 57);
        this.dust = makeSystem(46, [0.035, 0.07], 61);
        this.burst = makeSystem(80, [0.14, 0.34], 77);
        this.fountain = makeSystem(48, [0.12, 0.28], 89);

        const ringGeometry = new THREE.RingGeometry(0.52, 0.6, 72);
        this.ringMaterials = [
            new THREE.MeshBasicMaterial({
                color: 0xffcf9a,
                transparent: true,
                opacity: 0,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
            }),
            new THREE.MeshBasicMaterial({
                color: 0x9fe3ff,
                transparent: true,
                opacity: 0,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
            }),
        ];
        this.ringNear = new THREE.Mesh(ringGeometry, this.ringMaterials[0]);
        this.ringNear.position.set(0, 0.1, 0.4);
        this.ringFar = new THREE.Mesh(ringGeometry, this.ringMaterials[1]);
        this.ringFar.position.set(0, 0.1, 0.2);
        this.ringNear.visible = false;
        this.ringFar.visible = false;

        this.root.add(
            this.motes.points,
            this.dust.points,
            this.intake.points,
            this.intakeTrail.points,
            this.embers.points,
            this.emberTrail.points,
            this.wisps.points,
            this.orbit.points,
            this.ideaSpark.points,
            this.burst.points,
            this.fountain.points,
            this.ringNear,
            this.ringFar,
        );

        const random = makeRandom(101);
        this.moteOrigins = new Float32Array(this.motes.count * 3);
        for (let index = 0; index < this.motes.count; index += 1) {
            const radius = 0.8 + random() * 1.7;
            const angle = random() * TAU;
            this.moteOrigins[index * 3] = Math.cos(angle) * radius;
            this.moteOrigins[index * 3 + 1] = -0.95 + random() * 1.9;
            this.moteOrigins[index * 3 + 2] = Math.sin(angle) * radius;
        }

        this.dustOrigins = new Float32Array(this.dust.count * 3);
        for (let index = 0; index < this.dust.count; index += 1) {
            const radius = 1.2 + random() * 2.6;
            const angle = random() * TAU;
            this.dustOrigins[index * 3] = Math.cos(angle) * radius;
            this.dustOrigins[index * 3 + 1] = DUST_Y_FLOOR + random() * 2.4;
            this.dustOrigins[index * 3 + 2] = Math.sin(angle) * radius;
        }

        this.intakeAngle = new Float32Array(this.intake.count);
        this.intakeRadius = new Float32Array(this.intake.count);
        this.intakeHeight = new Float32Array(this.intake.count);
        this.intakeSpin = new Float32Array(this.intake.count);
        this.intakeCycles = new Float32Array(this.intake.count);
        for (let index = 0; index < this.intake.count; index += 1) {
            const seed = this.intake.seeds[index];
            this.intakeAngle[index] = seed * TAU;
            this.intakeRadius[index] = 0.3 + seed * 1.8;
            this.intakeHeight[index] = (seed - 0.5) * 0.8;
            this.intakeSpin[index] = 1.3 + ((seed * 7) % 1) * 1.7;
        }

        this.emberAge = new Float32Array(this.embers.count);
        this.emberVelocity = new Float32Array(this.embers.count * 3);
        for (let index = 0; index < this.embers.count; index += 1) {
            const seed = this.embers.seeds[index];
            this.emberAge[index] = 2;
            this.emberVelocity[index * 3] = (seed - 0.5) * 0.55;
            this.emberVelocity[index * 3 + 1] = 0.35 + seed * 0.75;
            this.emberVelocity[index * 3 + 2] = 0.15 + seed * 0.3;
        }

        this.wispSeeds = new Float32Array(this.wisps.count);
        this.wispAge = new Float32Array(this.wisps.count);
        for (let index = 0; index < this.wisps.count; index += 1) {
            this.wispSeeds[index] = this.wisps.seeds[index];
            this.wispAge[index] = index / this.wisps.count; // staggered for a continuous plume
        }

        const burstRandom = makeRandom(303);
        this.burstVelocity = new Float32Array(this.burst.count * 3);
        for (let index = 0; index < this.burst.count; index += 1) {
            const theta = burstRandom() * TAU;
            const phi = Math.acos(2 * burstRandom() - 1);
            const speed = 1.3 + burstRandom() * 2.1;
            this.burstVelocity[index * 3] = Math.sin(phi) * Math.cos(theta) * speed;
            this.burstVelocity[index * 3 + 1] = Math.cos(phi) * speed * 0.85;
            this.burstVelocity[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
        }

        const fountainRandom = makeRandom(404);
        this.fountainVelocity = new Float32Array(this.fountain.count * 3);
        for (let index = 0; index < this.fountain.count; index += 1) {
            const spread = (fountainRandom() - 0.5) * 0.9;
            this.fountainVelocity[index * 3] = spread * 0.8;
            this.fountainVelocity[index * 3 + 1] = 1.6 + fountainRandom() * 1.4;
            this.fountainVelocity[index * 3 + 2] = fountainRandom() * 0.4;
        }

        this.burstAge = 2;
    }

    getRoot(): THREE.Group {
        return this.root;
    }

    setCharacterState(state: CharacterState): void {
        if (state === this.state) {
            return;
        }
        this.state = state;
        if (state === "INTERRUPTED") {
            this.burstAge = 0;
            this.playEmotionAccent("dramatic");
        }
        if (state === "RECOVERING") {
            this.playEmotionAccent("smoke");
        }
    }

    /** A short, tasteful flourish tied to the character's reaction. */
    playEmotionAccent(emotion: string): void {
        switch (emotion) {
            case "delighted":
                this.accentKind = "fountain";
                this.accentAge = 0;
                break;
            case "amused":
                this.accentKind = "pulse";
                this.accentAge = 0;
                break;
            case "dramatic":
                this.accentKind = "pulse";
                this.accentAge = 0;
                if (this.burstAge > 1) {
                    this.burstAge = 0;
                }
                break;
            case "grumpy":
            case "suspicious":
                this.accentKind = "smoke";
                this.accentAge = 0;
                break;
            default:
                break;
        }
    }

    update(dtSeconds: number, facialState: FacialState): void {
        const dt = Math.min(dtSeconds, 0.1);
        this.elapsed += dt;
        this.burstAge += dt;
        this.accentAge += dt;
        if (this.accentAge > 1.8) {
            this.accentKind = "none";
        }

        const mouthActivity = Math.max(0, 1 - facialState.visemeWeights[0]);
        const listening = this.state === "LISTENING";
        const thinking = this.state === "THINKING" || this.state === "PREPARING_SPEECH";
        const speaking = this.state === "SPEAKING" || this.state === "PREPARING_SPEECH";

        // One palette glides between state colors; every system samples it.
        this.paletteColor.lerp(this.palettes[this.state], Math.min(1, dt * 1.6));

        this.motes.targetOpacity = 0.6;
        this.intake.targetOpacity = listening ? 0.95 : 0;
        this.intakeTrail.targetOpacity = listening ? 0.5 : 0;
        this.embers.targetOpacity = speaking ? 0.55 + 0.45 * mouthActivity : 0;
        this.emberTrail.targetOpacity = this.embers.targetOpacity * 0.55;
        this.wisps.targetOpacity = speaking ? 0.5 + 0.3 * mouthActivity : 0;
        this.orbit.targetOpacity = thinking ? 0.85 : 0;
        this.dust.targetOpacity = 0.28;
        const burstLife = this.burstAge / 0.9;
        this.burst.targetOpacity = burstLife < 1 ? 0.95 * (1 - burstLife) : 0;
        const fountainLife =
            this.accentKind === "fountain" ? this.accentAge : Number.POSITIVE_INFINITY;
        this.fountain.targetOpacity = fountainLife < 1.3 ? 0.9 * (1 - fountainLife / 1.3) : 0;

        this.updateMotes();
        this.updateIntake(dt, listening);
        this.updateEmbers(dt, speaking, mouthActivity);
        this.updateWisps(dt);
        this.updateOrbit();
        this.updateIdeaSpark(thinking);
        this.updateDust();
        this.updateBurst();
        this.updateFountain();
        this.updateShockwaves();

        for (const system of this.allSystems()) {
            system.opacity +=
                (system.targetOpacity - system.opacity) * Math.min(1, dt * OPACITY_RATE);
            system.material.uniforms.uOpacity.value = system.opacity;
            system.points.visible = system.opacity > 0.02;
            (system.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate =
                true;
            (system.points.geometry.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate =
                true;
            (system.points.geometry.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate =
                true;
        }
    }

    dispose(): void {
        for (const system of this.allSystems()) {
            system.points.geometry.dispose();
            system.material.dispose();
        }
        this.ringNear.geometry.dispose();
        for (const material of this.ringMaterials) {
            material.dispose();
        }
        this.root.clear();
    }

    private allSystems(): SoftSystem[] {
        return [
            this.motes,
            this.dust,
            this.intake,
            this.intakeTrail,
            this.embers,
            this.emberTrail,
            this.wisps,
            this.orbit,
            this.ideaSpark,
            this.burst,
            this.fountain,
        ];
    }

    private updateMotes(): void {
        const { positions, colors, sizes, seeds, count } = this.motes;
        let pulseBoost = 1;
        if (this.accentKind === "pulse" && this.accentAge < 0.9) {
            pulseBoost =
                1 + 0.9 * Math.sin((this.accentAge / 0.9) * TAU) * (1 - this.accentAge / 0.9);
        }
        for (let index = 0; index < count; index += 1) {
            const seed = seeds[index];
            const baseX = this.moteOrigins[index * 3];
            const baseY = this.moteOrigins[index * 3 + 1];
            const baseZ = this.moteOrigins[index * 3 + 2];
            positions[index * 3] =
                baseX + Math.sin(this.elapsed * (0.25 + seed * 0.2) + seed * 9) * 0.22;
            positions[index * 3 + 1] =
                baseY +
                Math.sin(this.elapsed * (0.18 + seed * 0.12) + seed * 17) * 0.16 +
                Math.sin(this.elapsed * 0.09 + seed * 40) * 0.07;
            positions[index * 3 + 2] =
                baseZ + Math.cos(this.elapsed * (0.22 + seed * 0.18) + seed * 5) * 0.22;
            const wave = Math.sin(this.elapsed * (0.7 + seed * 0.5) + seed * 23);
            const blink = Math.pow(Math.max(0, wave), 3);
            const intensity = (0.2 + 0.8 * blink) * pulseBoost;
            sizes[index] = 0.08 + seed * 0.14 + blink * 0.09;
            this.scratch.copy(this.paletteColor).lerp(this.amber, 0.5).multiplyScalar(intensity);
            colors[index * 3] = this.scratch.r;
            colors[index * 3 + 1] = this.scratch.g;
            colors[index * 3 + 2] = this.scratch.b;
        }
    }

    private updateIntake(dt: number, active: boolean): void {
        const { positions, colors, sizes, seeds, count } = this.intake;
        if (!active && this.intake.opacity < 0.02) {
            return;
        }
        const pull = 0.6 + this.intake.opacity * 0.5;
        for (let index = 0; index < count; index += 1) {
            const seed = seeds[index];
            let radius = this.intakeRadius[index];
            const easing = 0.35 + (1 - Math.min(1, radius / 2.1)) * 0.9;
            radius = Math.max(
                0.12,
                radius - (0.42 + radius * 0.5) * pull * easing * dt * (active ? 1 : 0.15),
            );
            if (radius <= 0.13) {
                this.intakeCycles[index] += 1;
                const cycle = this.intakeCycles[index];
                const randomAngle = (((seed * 91 + cycle * 37) % 1) + 1) % 1;
                this.intakeAngle[index] = randomAngle * TAU;
                this.intakeHeight[index] = (((seed * 57 + cycle * 13) % 1) - 0.5) * 0.8;
                radius = 1.9 + ((seed * 29 + cycle * 7) % 1) * 0.5;
            }
            this.intakeRadius[index] = radius;
            const angle =
                this.intakeAngle[index] +
                this.intakeSpin[index] * this.elapsed * (0.6 + (2.2 - radius) * 0.8);
            const height =
                this.intakeHeight[index] +
                Math.sin(this.elapsed * 1.6 + seed * 31) * 0.05 +
                Math.sin(angle * 2) * 0.03;
            const closeness = 1 - Math.min(1, (radius - 0.13) / 1.9);
            // Motes shift from moonlit cyan to the pumpkin's current palette
            // as they are absorbed, so the vortex feels alive.
            const absorbed = this.scratchB.copy(this.paletteColor).lerp(this.ghost, 0.35);
            this.scratch.copy(this.ghost).lerp(absorbed, closeness);
            positions[index * 3] = FACE.x + Math.sin(angle) * radius * 0.8;
            positions[index * 3 + 1] = FACE.y + height + radius * 0.08;
            positions[index * 3 + 2] = FACE.z + Math.cos(angle) * radius * 0.8 - 0.45;
            const intensity = 0.55 + closeness * 0.45;
            colors[index * 3] = this.scratch.r * intensity;
            colors[index * 3 + 1] = this.scratch.g * intensity;
            colors[index * 3 + 2] = this.scratch.b * intensity;
            sizes[index] = 0.08 + closeness * 0.16;
        }
        this.fillTrail(this.intake, this.intakeTrail, 0.45, 0.55);
    }

    private updateEmbers(dt: number, speaking: boolean, mouthActivity: number): void {
        const { positions, colors, sizes, seeds, count } = this.embers;
        if (!speaking && this.embers.opacity < 0.02) {
            return;
        }
        const smokeShift = this.accentKind === "smoke" ? Math.max(0, 1 - this.accentAge / 1.8) : 0;
        for (let index = 0; index < count; index += 1) {
            const seed = seeds[index];
            let age = this.emberAge[index];
            const lifetime = 0.55 + seed * 0.65;
            age += dt / lifetime;
            if (age >= 1) {
                if (mouthActivity > 0.05 && this.embers.opacity > 0.15) {
                    age = 0;
                } else {
                    age = 1;
                }
            }
            this.emberAge[index] = age;
            const seconds = age * lifetime;
            const vx = this.emberVelocity[index * 3];
            const vy = this.emberVelocity[index * 3 + 1];
            const vz = this.emberVelocity[index * 3 + 2];
            const sway = Math.sin(this.elapsed * 4 + seed * 44) * 0.06 * seconds;
            positions[index * 3] = MOUTH.x + vx * seconds + sway;
            positions[index * 3 + 1] =
                MOUTH.y + vy * seconds * (1.1 + mouthActivity * 0.5) - 0.32 * seconds * seconds;
            positions[index * 3 + 2] = MOUTH.z + vz * seconds;
            const heat = Math.max(0, 1 - seconds * 1.6);
            this.scratch
                .copy(this.emberDeepFromState())
                .lerp(this.emberHot, heat * (1 - smokeShift));
            const fade = age >= 1 ? 0.12 : 0.5 + 0.5 * (1 - age);
            colors[index * 3] = this.scratch.r * fade;
            colors[index * 3 + 1] = this.scratch.g * fade;
            colors[index * 3 + 2] = this.scratch.b * fade;
            sizes[index] = (0.17 + seed * 0.15) * (1 - age * 0.7);
        }
        this.fillTrail(this.embers, this.emberTrail, 0.4, 0.5);
    }

    private emberDeepFromState(): THREE.Color {
        return this.scratchB.copy(this.emberDeep).lerp(this.paletteColor, 0.25);
    }

    /** Large slow flame lobes rising from the mouth in a gentle S-curve. */
    private updateWisps(dt: number): void {
        const { positions, colors, sizes, count } = this.wisps;
        if (this.wisps.opacity < 0.02 && this.wisps.targetOpacity <= 0) {
            return;
        }
        for (let index = 0; index < count; index += 1) {
            const seed = this.wispSeeds[index];
            let age = this.wispAge[index] + dt / 1.5;
            if (age >= 1) {
                age -= 1;
            }
            this.wispAge[index] = age;
            const rise = age * 1.1;
            const sway = Math.sin(rise * 5 + seed * TAU) * (0.05 + rise * 0.12);
            positions[index * 3] = MOUTH.x + (seed - 0.5) * 0.22 + sway;
            positions[index * 3 + 1] = MOUTH.y + rise;
            positions[index * 3 + 2] = MOUTH.z + 0.05 + Math.cos(rise * 4 + seed * 9) * 0.05;
            this.scratch.copy(this.paletteColor).lerp(this.emberHot, 1 - age);
            const fade = Math.sin(age * Math.PI);
            colors[index * 3] = this.scratch.r * fade;
            colors[index * 3 + 1] = this.scratch.g * fade;
            colors[index * 3 + 2] = this.scratch.b * fade;
            sizes[index] = 0.2 + 0.22 * fade;
        }
    }

    private updateOrbit(): void {
        const { positions, colors, sizes, seeds, count } = this.orbit;
        for (let index = 0; index < count; index += 1) {
            const seed = seeds[index];
            const ring = index % 2;
            const direction = ring === 0 ? 1 : -1;
            const radiusX = ring === 0 ? 0.44 : 0.6;
            const radiusZ = radiusX * (0.82 + 0.08 * Math.sin(this.elapsed * 0.7 + seed * 6));
            const angle = direction * this.elapsed * (0.9 + seed * 0.5) + seed * TAU;
            positions[index * 3] = Math.cos(angle) * radiusX;
            positions[index * 3 + 1] =
                0.74 + Math.sin(this.elapsed * 1.4 + seed * 21) * 0.09 + ring * 0.05;
            positions[index * 3 + 2] = Math.sin(angle) * radiusZ;
            const pulse = 0.55 + 0.45 * Math.sin(this.elapsed * 3.4 + seed * 57);
            this.scratch.copy(this.paletteColor).lerp(this.amber, 0.6);
            colors[index * 3] = this.scratch.r * pulse;
            colors[index * 3 + 1] = this.scratch.g * pulse;
            colors[index * 3 + 2] = this.scratch.b * pulse;
            sizes[index] = 0.08 + pulse * 0.09;
        }
    }

    /** One bright thought that arcs over the head and vanishes. */
    private updateIdeaSpark(active: boolean): void {
        const { positions, colors, sizes, count } = this.ideaSpark;
        if (count === 0) {
            return;
        }
        const cycle = this.elapsed % 2.6;
        const visible = active && cycle < 1.3;
        if (!visible) {
            sizes[0] = 0;
            colors[0] = 0;
            colors[1] = 0;
            colors[2] = 0;
            return;
        }
        const progress = cycle / 1.3;
        const arc = Math.sin(progress * Math.PI);
        positions[0] = Math.sin(progress * Math.PI * 2) * 0.16;
        positions[1] = 0.78 + 0.55 * arc;
        positions[2] = 0.1 * arc;
        this.scratch.copy(this.paletteColor).lerp(this.emberHot, arc);
        const twinkle = 0.6 + 0.4 * Math.sin(this.elapsed * 22);
        colors[0] = this.scratch.r * twinkle;
        colors[1] = this.scratch.g * twinkle;
        colors[2] = this.scratch.b * twinkle;
        sizes[0] = 0.14 + 0.16 * arc;
    }

    private updateDust(): void {
        const { positions, colors, sizes, seeds, count } = this.dust;
        for (let index = 0; index < count; index += 1) {
            const seed = seeds[index];
            const baseX = this.dustOrigins[index * 3];
            const baseY = this.dustOrigins[index * 3 + 1];
            const baseZ = this.dustOrigins[index * 3 + 2];
            positions[index * 3] =
                baseX + Math.sin(this.elapsed * (0.06 + seed * 0.05) + seed * 13) * 0.5;
            positions[index * 3 + 1] =
                baseY + Math.sin(this.elapsed * (0.05 + seed * 0.04) + seed * 29) * 0.3;
            positions[index * 3 + 2] =
                baseZ + Math.cos(this.elapsed * (0.05 + seed * 0.05) + seed * 7) * 0.5;
            const shimmer = 0.4 + 0.6 * Math.sin(this.elapsed * 0.8 + seed * 47);
            this.scratch
                .copy(this.taupe)
                .lerp(this.paletteColor, 0.35)
                .multiplyScalar(0.4 + 0.6 * shimmer);
            colors[index * 3] = this.scratch.r;
            colors[index * 3 + 1] = this.scratch.g;
            colors[index * 3 + 2] = this.scratch.b;
        }
    }

    private updateBurst(): void {
        const { positions, colors, sizes, count } = this.burst;
        if (this.burstAge > 0.9 && this.burst.opacity <= 0.02) {
            return;
        }
        const age = this.burstAge;
        for (let index = 0; index < count; index += 1) {
            const base = index * 3;
            const drag = Math.max(0, 1 - age * 0.4);
            positions[base] = this.burstVelocity[base] * age * drag;
            positions[base + 1] = 0.1 + this.burstVelocity[base + 1] * age * drag - 0.7 * age * age;
            positions[base + 2] = this.burstVelocity[base + 2] * age * drag;
            const heat = Math.max(0, 1 - age * 2.2);
            this.scratch
                .copy(this.scratchB.copy(this.emberDeep).lerp(this.paletteColor, 0.3))
                .lerp(this.emberHot, heat);
            colors[base] = this.scratch.r;
            colors[base + 1] = this.scratch.g;
            colors[base + 2] = this.scratch.b;
            sizes[index] = 0.3 * Math.max(0.15, 1 - age);
        }
    }

    /** Golden fountain rising from the mouth for the delighted/dramatic beats. */
    private updateFountain(): void {
        const { positions, colors, sizes, seeds, count } = this.fountain;
        if (this.accentKind !== "fountain" || this.accentAge > 1.3) {
            return;
        }
        const age = this.accentAge;
        for (let index = 0; index < count; index += 1) {
            const base = index * 3;
            const seed = seeds[index];
            const delay = seed * 0.25;
            const t = Math.max(0, age - delay);
            const drag = Math.max(0, 1 - t * 0.35);
            positions[base] = MOUTH.x + this.fountainVelocity[base] * t * drag;
            positions[base + 1] = MOUTH.y + this.fountainVelocity[base + 1] * t - 1.6 * t * t;
            positions[base + 2] = MOUTH.z + this.fountainVelocity[base + 2] * t;
            const life = Math.min(1, t / 0.9);
            this.scratch.copy(this.paletteColor).lerp(this.emberHot, 1 - life);
            const fade = 1 - life;
            colors[base] = this.scratch.r * fade;
            colors[base + 1] = this.scratch.g * fade;
            colors[base + 2] = this.scratch.b * fade;
            sizes[index] = (0.12 + seed * 0.14) * Math.max(0.1, 1 - life * 0.8);
        }
    }

    private updateShockwaves(): void {
        const age = this.burstAge;
        if (age > SHOCKWAVE_SECONDS) {
            this.ringNear.visible = false;
            this.ringFar.visible = false;
            return;
        }
        const near = Math.min(1, age / SHOCKWAVE_SECONDS);
        this.ringNear.visible = true;
        this.ringNear.scale.setScalar(0.35 + near * 2.8);
        this.ringMaterials[0].opacity = 0.8 * (1 - near) * (1 - near);

        const farAge = age - 0.12;
        if (farAge > 0 && farAge < SHOCKWAVE_SECONDS) {
            const far = farAge / SHOCKWAVE_SECONDS;
            this.ringFar.visible = true;
            this.ringFar.scale.setScalar(0.25 + far * 3.6);
            this.ringMaterials[1].opacity = 0.45 * (1 - far) * (1 - far);
        } else {
            this.ringFar.visible = false;
        }
    }

    /** Copies a lead system one step back as a scaled, dimmed echo. */
    private fillTrail(
        lead: SoftSystem,
        trail: SoftSystem,
        colorScale: number,
        sizeScale: number,
    ): void {
        const count = Math.min(lead.count, trail.count);
        for (let index = 0; index < count; index += 1) {
            trail.positions[index * 3] = lead.positions[index * 3];
            trail.positions[index * 3 + 1] = lead.positions[index * 3 + 1];
            trail.positions[index * 3 + 2] = lead.positions[index * 3 + 2];
            trail.colors[index * 3] = lead.colors[index * 3] * colorScale;
            trail.colors[index * 3 + 1] = lead.colors[index * 3 + 1] * colorScale;
            trail.colors[index * 3 + 2] = lead.colors[index * 3 + 2] * colorScale;
            trail.sizes[index] = lead.sizes[index] * sizeScale;
        }
    }
}

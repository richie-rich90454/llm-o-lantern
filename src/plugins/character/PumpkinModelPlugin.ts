import * as THREE from "three";
import { ModelCapabilities } from "../../data/CharacterState";
import type { FacialState } from "../../data/CharacterState";
import type { CharacterModelConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";

export type CharacterModelPluginShape = {
  createModel(): THREE.Group;
  getCapabilities(): ModelCapabilities;
  applyFacialState(state: FacialState, dtSeconds: number): void;
  dispose(): void;
};

type PumpkinParts = {
  root: THREE.Group;
  leftEye: THREE.Mesh;
  rightEye: THREE.Mesh;
  mouthGeometry: THREE.BufferGeometry;
  mouthPositions: THREE.BufferAttribute;
  eyeMaterial: THREE.MeshStandardMaterial;
  mouthMaterial: THREE.MeshStandardMaterial;
  teethMaterial: THREE.MeshStandardMaterial;
  teeth: THREE.Mesh;
  faceLight: THREE.PointLight;
  groundGlow: THREE.PointLight;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export class PumpkinModelPlugin {
  readonly id = "character.pumpkin";
  readonly version = "1.0.0";
  readonly category = "character";

  // Every procedural constant lives here so the model can be re-tuned in one place.
  private static readonly TUNING = {
    viseme: { sil: 0, closed: 1, fv: 2, open: 3, wide: 4, round: 5, narrow: 6, intermediate: 7 },
    body: {
      segmentsWidth: 96,
      segmentsHeight: 64,
      ribCount: 9,
      ribAmplitude: 0.045,
      verticalSquash: 0.8,
      topTaper: 0.1,
      roughness: 0.62,
      metalness: 0.02
    },
    stem: {
      radius: 0.07,
      tubularSegments: 24,
      radialSegments: 8,
      roughness: 0.9,
      points: [
        [0, 0.72, 0],
        [0.05, 0.9, 0.02],
        [0.02, 1.06, 0.06],
        [-0.04, 1.14, 0.02]
      ]
    },
    eyes: {
      color: 0x2a1204,
      emissiveIntensity: 1.5,
      roughness: 0.5,
      extrudeDepth: 0.02,
      leftPosition: [-0.42, 0.18, 0.936],
      rightPosition: [0.42, 0.18, 0.936],
      yaw: 0.42,
      tilt: 0.1,
      baseScaleX: 0.36,
      baseScaleY: 0.34,
      baseScaleZ: 1,
      scaleClampMin: 0.7,
      scaleClampMax: 1.4,
      opennessClampMin: 0.08,
      opennessClampMax: 1.3,
      tiltClamp: 0.4,
      outline: [
        [-0.5, -0.3],
        [-0.15, -0.62, 0, -0.45],
        [0.15, -0.62, 0.5, -0.3],
        [0.3, 0.28, 0, 0.48],
        [-0.3, 0.28, -0.5, -0.3]
      ]
    },
    mouth: {
      columns: 25,
      rows: 5,
      color: 0x2a1204,
      emissiveIntensity: 1.6,
      roughness: 0.55,
      // The mouth is projected onto this sphere so every vertex sits just
      // proud of the ribbed pumpkin surface: no intersections, no floating.
      faceRadius: 1.05,
      centerY: -0.34,
      minimumHalfWidth: 0.12,
      halfWidthBase: 0.36,
      halfWidthGain: 0.7,
      halfWidthWide: 0.4,
      halfWidthRoundLoss: 0.35,
      profilePowerBase: 0.62,
      profilePowerRoundLoss: 0.2,
      opennessBase: 0.34,
      opennessClosureLoss: 0.92,
      opennessRoundLoss: 0.22,
      topProfile: 0.1,
      bottomProfile: 0.08,
      bottomOpenness: 1.3
    },
    teeth: {
      width: 0.46,
      height: 0.1,
      depth: 0.03,
      color: 0x3a2a12,
      emissiveIntensity: 0.8,
      roughness: 0.6,
      position: [0, -0.26, 0.998],
      visibilityThreshold: 0.05,
      minimumScaleY: 0.01
    },
    lights: {
      faceIntensity: 2.2,
      faceDistance: 7,
      faceDecay: 2,
      facePosition: [0, -0.05, 1.35],
      groundIntensity: 0.9,
      groundDistance: 3.5,
      groundDecay: 2,
      groundPosition: [0, -0.8, 0.9]
    },
    animation: {
      smoothingSeconds: 0.05,
      geometryEpsilon: 0.004,
      warmthEpsilon: 0.01,
      glowIntensityMax: 1.6,
      openWideWeight: 0.38,
      openRoundWeight: 0.42,
      openNarrowWeight: 0.18,
      openIntermediateWeight: 0.15,
      openFvWeight: 0.1,
      wideOpenWeight: 0.22,
      wideFvWeight: 0.42,
      roundNarrowWeight: 0.85,
      headTiltClamp: 0.35,
      headSwayClamp: 0.3,
      bobClamp: 0.06
    }
  };

  private readonly config: CharacterModelConfig;
  private readonly logger: ApplicationLogger;
  private readonly eyeBaseScaleX: number;
  private readonly eyeBaseScaleY: number;
  private readonly eyeBaseScaleZ: number;
  private readonly leftEyeBaseTilt: number;
  private readonly rightEyeBaseTilt: number;
  private readonly glowBaseColor: THREE.Color;
  private readonly glowHotBaseColor: THREE.Color;
  private readonly warmthScratch = new THREE.Color();

  private parts: PumpkinParts | null = null;
  private currentOpen = 0;
  private currentWide = 0;
  private currentRound = 0;
  private currentClosure = 0;
  private currentTeeth = 0;
  private currentWarmth = -1;

  constructor(config: CharacterModelConfig, logger: ApplicationLogger) {
    this.config = config;
    this.logger = logger;
    const tuning = PumpkinModelPlugin.TUNING;
    this.eyeBaseScaleX = tuning.eyes.baseScaleX;
    this.eyeBaseScaleY = tuning.eyes.baseScaleY;
    this.eyeBaseScaleZ = tuning.eyes.baseScaleZ;
    this.leftEyeBaseTilt = tuning.eyes.tilt;
    this.rightEyeBaseTilt = -tuning.eyes.tilt;
    this.glowBaseColor = new THREE.Color(config.glowColor);
    this.glowHotBaseColor = new THREE.Color(config.glowHotColor);
  }

  createModel(): THREE.Group {
    const tuning = PumpkinModelPlugin.TUNING;
    const root = new THREE.Group();

    const bodyGeometry = new THREE.SphereGeometry(1, tuning.body.segmentsWidth, tuning.body.segmentsHeight);
    const bodyPositions = bodyGeometry.attributes.position as THREE.BufferAttribute;
    for (let index = 0; index < bodyPositions.count; index += 1) {
      const x = bodyPositions.getX(index);
      const z = bodyPositions.getZ(index);
      const theta = Math.atan2(z, x);
      const rib = 1 + tuning.body.ribAmplitude * Math.cos(theta * tuning.body.ribCount);
      let y = bodyPositions.getY(index) * tuning.body.verticalSquash;
      // Radial rib cosine carves the pumpkin grooves; the small quadratic
      // taper on the upper half keeps the crown flatter than a plain sphere.
      if (y > 0) {
        y -= tuning.body.topTaper * y * y;
      }
      bodyPositions.setXYZ(index, x * rib, y, z * rib);
    }
    bodyPositions.needsUpdate = true;
    bodyGeometry.computeVertexNormals();
    const body = new THREE.Mesh(
      bodyGeometry,
      new THREE.MeshStandardMaterial({
        color: this.config.pumpkinColor,
        roughness: tuning.body.roughness,
        metalness: tuning.body.metalness
      })
    );
    body.name = "body";
    root.add(body);

    const stemPoints: THREE.Vector3[] = [];
    for (const point of tuning.stem.points) {
      stemPoints.push(new THREE.Vector3(point[0], point[1], point[2]));
    }
    const stemGeometry = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(stemPoints),
      tuning.stem.tubularSegments,
      tuning.stem.radius,
      tuning.stem.radialSegments,
      false
    );
    const stem = new THREE.Mesh(
      stemGeometry,
      new THREE.MeshStandardMaterial({ color: this.config.stemColor, roughness: tuning.stem.roughness })
    );
    stem.name = "stem";
    root.add(stem);

    const eyeShape = new THREE.Shape();
    const outline = tuning.eyes.outline;
    eyeShape.moveTo(outline[0][0], outline[0][1]);
    for (let index = 1; index < outline.length; index += 1) {
      const curve = outline[index];
      eyeShape.quadraticCurveTo(curve[0], curve[1], curve[2], curve[3]);
    }
    const eyeGeometry = new THREE.ExtrudeGeometry(eyeShape, {
      depth: tuning.eyes.extrudeDepth,
      bevelEnabled: false
    });
    const eyeMaterial = new THREE.MeshStandardMaterial({
      color: tuning.eyes.color,
      emissive: this.config.glowColor,
      emissiveIntensity: tuning.eyes.emissiveIntensity,
      roughness: tuning.eyes.roughness
    });
    const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    leftEye.name = "leftEye";
    leftEye.position.set(tuning.eyes.leftPosition[0], tuning.eyes.leftPosition[1], tuning.eyes.leftPosition[2]);
    leftEye.rotation.y = -tuning.eyes.yaw;
    leftEye.rotation.z = tuning.eyes.tilt;
    leftEye.scale.set(this.eyeBaseScaleX, this.eyeBaseScaleY, this.eyeBaseScaleZ);
    const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    rightEye.name = "rightEye";
    rightEye.position.set(tuning.eyes.rightPosition[0], tuning.eyes.rightPosition[1], tuning.eyes.rightPosition[2]);
    rightEye.rotation.y = tuning.eyes.yaw;
    rightEye.rotation.z = -tuning.eyes.tilt;
    rightEye.scale.set(this.eyeBaseScaleX, this.eyeBaseScaleY, this.eyeBaseScaleZ);
    root.add(leftEye, rightEye);

    const mouthVertexCount = tuning.mouth.columns * tuning.mouth.rows;
    const mouthGeometry = new THREE.BufferGeometry();
    const mouthPositions = new THREE.BufferAttribute(new Float32Array(mouthVertexCount * 3), 3);
    mouthGeometry.setAttribute("position", mouthPositions);
    const mouthIndices: number[] = [];
    for (let column = 0; column < tuning.mouth.columns - 1; column += 1) {
      for (let row = 0; row < tuning.mouth.rows - 1; row += 1) {
        const a = column * tuning.mouth.rows + row;
        const b = (column + 1) * tuning.mouth.rows + row;
        const c = b + 1;
        const d = a + 1;
        mouthIndices.push(a, b, d, b, c, d);
      }
    }
    mouthGeometry.setIndex(mouthIndices);
    const mouthMaterial = new THREE.MeshStandardMaterial({
      color: tuning.mouth.color,
      emissive: this.config.glowColor,
      emissiveIntensity: tuning.mouth.emissiveIntensity,
      roughness: tuning.mouth.roughness,
      side: THREE.DoubleSide
    });
    const mouth = new THREE.Mesh(mouthGeometry, mouthMaterial);
    mouth.name = "mouth";
    root.add(mouth);

    const teethMaterial = new THREE.MeshStandardMaterial({
      color: tuning.teeth.color,
      emissive: this.config.glowColor,
      emissiveIntensity: tuning.teeth.emissiveIntensity,
      roughness: tuning.teeth.roughness
    });
    const teeth = new THREE.Mesh(
      new THREE.BoxGeometry(tuning.teeth.width, tuning.teeth.height, tuning.teeth.depth),
      teethMaterial
    );
    teeth.name = "teeth";
    teeth.position.set(tuning.teeth.position[0], tuning.teeth.position[1], tuning.teeth.position[2]);
    teeth.visible = false;
    teeth.scale.y = tuning.teeth.minimumScaleY;
    root.add(teeth);

    const faceLight = new THREE.PointLight(
      this.config.glowColor,
      tuning.lights.faceIntensity,
      tuning.lights.faceDistance,
      tuning.lights.faceDecay
    );
    faceLight.position.set(tuning.lights.facePosition[0], tuning.lights.facePosition[1], tuning.lights.facePosition[2]);
    const groundGlow = new THREE.PointLight(
      this.config.glowColor,
      tuning.lights.groundIntensity,
      tuning.lights.groundDistance,
      tuning.lights.groundDecay
    );
    groundGlow.position.set(
      tuning.lights.groundPosition[0],
      tuning.lights.groundPosition[1],
      tuning.lights.groundPosition[2]
    );
    root.add(faceLight, groundGlow);

    this.parts = {
      root,
      leftEye,
      rightEye,
      mouthGeometry,
      mouthPositions,
      eyeMaterial,
      mouthMaterial,
      teethMaterial,
      teeth,
      faceLight,
      groundGlow
    };
    this.updateMouthGeometry(this.currentOpen, this.currentWide, this.currentRound, this.currentClosure);

    this.logger.debug("Procedural pumpkin model created", {
      pumpkinColor: this.config.pumpkinColor,
      glowColor: this.config.glowColor
    });
    return root;
  }

  getCapabilities(): ModelCapabilities {
    return new ModelCapabilities({ supportsTeeth: true, supportsJawDrop: true, supportsEyeAnimation: true });
  }

  applyFacialState(state: FacialState, dtSeconds: number): void {
    const parts = this.parts;
    if (parts === null) {
      return;
    }
    const tuning = PumpkinModelPlugin.TUNING;
    const animation = tuning.animation;
    const weights = state.visemeWeights;
    const viseme = tuning.viseme;

    // Weight order: 0 SIL, 1 CLOSED, 2 FV, 3 OPEN, 4 WIDE, 5 ROUND, 6 NARROW, 7 INTERMEDIATE.
    // SIL is the rest pose, so channel 0 contributes nothing.
    const closed = weights[viseme.closed];
    const fv = weights[viseme.fv];
    const open = weights[viseme.open];
    const wide = weights[viseme.wide];
    const round = weights[viseme.round];
    const narrow = weights[viseme.narrow];
    const intermediate = weights[viseme.intermediate];

    const targetOpen = clamp01(
      open +
        wide * animation.openWideWeight +
        round * animation.openRoundWeight +
        narrow * animation.openNarrowWeight +
        intermediate * animation.openIntermediateWeight +
        fv * animation.openFvWeight
    );
    const targetWide = clamp01(wide + open * animation.wideOpenWeight + fv * animation.wideFvWeight);
    const targetRound = clamp01(round + narrow * animation.roundNarrowWeight);
    const targetClosure = clamp01(closed);
    const targetTeeth = clamp01(fv);

    const blend = Math.min(1, dtSeconds / animation.smoothingSeconds);
    const previousOpen = this.currentOpen;
    const previousWide = this.currentWide;
    const previousRound = this.currentRound;
    const previousClosure = this.currentClosure;
    this.currentOpen += (targetOpen - this.currentOpen) * blend;
    this.currentWide += (targetWide - this.currentWide) * blend;
    this.currentRound += (targetRound - this.currentRound) * blend;
    this.currentClosure += (targetClosure - this.currentClosure) * blend;
    this.currentTeeth += (targetTeeth - this.currentTeeth) * blend;

    const mouthMoved =
      Math.abs(this.currentOpen - previousOpen) > animation.geometryEpsilon ||
      Math.abs(this.currentWide - previousWide) > animation.geometryEpsilon ||
      Math.abs(this.currentRound - previousRound) > animation.geometryEpsilon ||
      Math.abs(this.currentClosure - previousClosure) > animation.geometryEpsilon;
    if (mouthMoved) {
      this.updateMouthGeometry(this.currentOpen, this.currentWide, this.currentRound, this.currentClosure);
    }

    const eyeScale = clamp(state.eyeScale, tuning.eyes.scaleClampMin, tuning.eyes.scaleClampMax);
    const eyeOpenness = clamp(state.eyeOpen, tuning.eyes.opennessClampMin, tuning.eyes.opennessClampMax);
    const eyeTilt = clamp(state.eyeTilt, -tuning.eyes.tiltClamp, tuning.eyes.tiltClamp);
    parts.leftEye.scale.set(
      this.eyeBaseScaleX * eyeScale,
      this.eyeBaseScaleY * eyeScale * eyeOpenness,
      this.eyeBaseScaleZ
    );
    parts.rightEye.scale.copy(parts.leftEye.scale);
    parts.leftEye.rotation.z = this.leftEyeBaseTilt + eyeTilt;
    parts.rightEye.rotation.z = this.rightEyeBaseTilt - eyeTilt;

    const glow = clamp(state.glowIntensity, 0, animation.glowIntensityMax);
    parts.mouthMaterial.emissiveIntensity = tuning.mouth.emissiveIntensity * glow;
    parts.eyeMaterial.emissiveIntensity = tuning.eyes.emissiveIntensity * glow;
    parts.teethMaterial.emissiveIntensity = tuning.teeth.emissiveIntensity * glow;
    parts.faceLight.intensity = tuning.lights.faceIntensity * glow;
    parts.groundGlow.intensity = tuning.lights.groundIntensity * glow;

    const warmth = clamp01(state.glowWarmth);
    if (Math.abs(warmth - this.currentWarmth) > animation.warmthEpsilon) {
      this.currentWarmth = warmth;
      this.warmthScratch.copy(this.glowBaseColor).lerp(this.glowHotBaseColor, warmth);
      // Clones, never the scratch itself: assigning the shared scratch would
      // alias one Color instance into every emissive and light.
      parts.mouthMaterial.emissive = this.warmthScratch.clone();
      parts.eyeMaterial.emissive = this.warmthScratch.clone();
      parts.teethMaterial.emissive = this.warmthScratch.clone();
      parts.faceLight.color = this.warmthScratch.clone();
      parts.groundGlow.color = this.warmthScratch.clone();
    }

    parts.root.rotation.z = clamp(state.headTilt, -animation.headTiltClamp, animation.headTiltClamp);
    parts.root.rotation.y = clamp(state.headSway, -animation.headSwayClamp, animation.headSwayClamp);
    parts.root.position.y = clamp(state.bob, -animation.bobClamp, animation.bobClamp);

    parts.teeth.visible = this.currentTeeth > tuning.teeth.visibilityThreshold;
    parts.teeth.scale.y = Math.max(tuning.teeth.minimumScaleY, this.currentTeeth);
  }

  dispose(): void {
    const parts = this.parts;
    if (parts === null) {
      return;
    }
    parts.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          entry.dispose();
        }
      } else {
        material.dispose();
      }
    });
    this.logger.debug("Procedural pumpkin model disposed");
  }

  private updateMouthGeometry(open: number, wide: number, round: number, closure: number): void {
    const parts = this.parts;
    if (parts === null) {
      return;
    }
    const tuning = PumpkinModelPlugin.TUNING.mouth;
    const verticalSquash = PumpkinModelPlugin.TUNING.body.verticalSquash;
    const positions = parts.mouthPositions;

    const halfWidth = Math.max(
      tuning.minimumHalfWidth,
      tuning.halfWidthBase * (tuning.halfWidthGain + tuning.halfWidthWide * wide) * (1 - tuning.halfWidthRoundLoss * round)
    );
    const profilePower = tuning.profilePowerBase - tuning.profilePowerRoundLoss * round;
    const openness =
      tuning.opennessBase * open * (1 - tuning.opennessClosureLoss * closure) * (1 - tuning.opennessRoundLoss * round);

    // Parametric grid: a parabolic profile shapes the lip band, and the
    // lower lip drops further than the upper so the mesh reads as a jaw.
    // Vertices are placed in world space and projected onto a sphere slightly
    // larger than the ribbed body, so the glowing carve always hugs the
    // surface instead of intersecting or floating.
    const radiusSquared = tuning.faceRadius * tuning.faceRadius;
    let vertex = 0;
    for (let column = 0; column < tuning.columns; column += 1) {
      const u = -1 + (2 * column) / (tuning.columns - 1);
      const profile = Math.pow(Math.max(0, 1 - u * u), profilePower);
      const topY = tuning.topProfile * profile + openness * profile;
      const bottomY = -tuning.bottomProfile * profile - openness * tuning.bottomOpenness * profile;
      const x = u * halfWidth;
      for (let row = 0; row < tuning.rows; row += 1) {
        const v = row / (tuning.rows - 1);
        const worldY = tuning.centerY + topY * (1 - v) + bottomY * v;
        const normalizedY = worldY / verticalSquash;
        const z = Math.sqrt(Math.max(0.05, radiusSquared - x * x - normalizedY * normalizedY));
        positions.setXYZ(vertex, x, worldY, z);
        vertex += 1;
      }
    }
    positions.needsUpdate = true;
    parts.mouthGeometry.computeVertexNormals();
    parts.mouthGeometry.computeBoundingSphere();
  }
}

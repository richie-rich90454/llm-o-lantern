import { describe, expect, it } from "vitest";
import type * as THREE from "three";
import { PumpkinModelPlugin } from "../../src/plugins/character/PumpkinModelPlugin";
import { FacialState } from "../../src/data/CharacterState";
import { createCapturingLogger } from "../fixtures/fakePlugins";

const VERTICAL_SQUASH = 0.8;
const MIN_SURFACE_RADIUS = 1.0;

function makePlugin(): PumpkinModelPlugin {
  const { logger } = createCapturingLogger();
  return new PumpkinModelPlugin(
    {
      pumpkinColor: "#d7691f",
      stemColor: "#5a4a2f",
      glowColor: "#ff9a2a",
      glowHotColor: "#ffd66b"
    },
    logger
  );
}

function findByName(root: THREE.Object3D, name: string): THREE.Object3D {
  let found: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (object.name === name) {
      found = object;
    }
  });
  if (found === null) {
    throw new Error(`Mesh "${name}" was not found in the pumpkin model`);
  }
  return found as unknown as THREE.Object3D;
}

describe("PumpkinModelPlugin geometry", () => {
  it("names its parts so tests and debugging can address them", () => {
    const plugin = makePlugin();
    const root = plugin.createModel();
    for (const name of ["body", "stem", "mouth", "teeth", "leftEye", "rightEye"]) {
      expect(() => findByName(root, name)).not.toThrow();
    }
    plugin.dispose();
  });

  it("keeps eyes and teeth outside the pumpkin surface so nothing intersects", () => {
    const plugin = makePlugin();
    const root = plugin.createModel();
    const state = new FacialState();
    plugin.applyFacialState(state, 1);

    for (const name of ["leftEye", "rightEye"] as const) {
      const eye = findByName(root, name);
      const distance = Math.hypot(eye.position.x, eye.position.y, eye.position.z);
      expect(distance).toBeGreaterThanOrEqual(MIN_SURFACE_RADIUS);
    }

    const teeth = findByName(root, "teeth");
    expect(Math.abs(teeth.position.z)).toBeGreaterThanOrEqual(0.95);
    plugin.dispose();
  });

  it("projects every mouth vertex onto the outer surface for closed and open poses", () => {
    const plugin = makePlugin();
    const root = plugin.createModel();
    const mouth = findByName(root, "mouth");
    const geometry = (mouth as unknown as { geometry: THREE.BufferGeometry }).geometry;
    const positions = geometry.getAttribute("position");

    const states: FacialState[] = [];
    const closed = new FacialState();
    closed.visemeWeights.fill(0);
    closed.visemeWeights[0] = 1; // SIL
    states.push(closed);
    const open = new FacialState();
    open.visemeWeights.fill(0);
    open.visemeWeights[3] = 1; // OPEN
    states.push(open);

    for (const state of states) {
      plugin.applyFacialState(state, 1);
      for (let index = 0; index < positions.count; index += 1) {
        const x = positions.getX(index);
        const y = positions.getY(index) / VERTICAL_SQUASH;
        const z = positions.getZ(index);
        const radius = Math.hypot(x, y, z);
        expect(radius).toBeGreaterThanOrEqual(MIN_SURFACE_RADIUS);
      }
    }
    plugin.dispose();
  });

  it("opens the mouth taller when an open viseme plays", () => {
    const plugin = makePlugin();
    const root = plugin.createModel();
    const mouth = findByName(root, "mouth") as unknown as THREE.Mesh;
    const geometry = mouth.geometry;

    const closed = new FacialState();
    closed.visemeWeights.fill(0);
    closed.visemeWeights[0] = 1;
    plugin.applyFacialState(closed, 1);
    geometry.computeBoundingBox();
    const closedHeight = (geometry.boundingBox?.max.y ?? 0) - (geometry.boundingBox?.min.y ?? 0);

    const open = new FacialState();
    open.visemeWeights.fill(0);
    open.visemeWeights[3] = 1;
    plugin.applyFacialState(open, 1);
    geometry.computeBoundingBox();
    const openHeight = (geometry.boundingBox?.max.y ?? 0) - (geometry.boundingBox?.min.y ?? 0);

    expect(openHeight).toBeGreaterThan(closedHeight * 1.3);
    plugin.dispose();
  });
});

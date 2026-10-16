import * as THREE from "three";

const BACKGROUND_COLOR = 0x05030a;
const FOG_NEAR = 4;
const FOG_FAR = 14;

const CAMERA_FIELD_OF_VIEW = 45;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
const CAMERA_POSITION_X = 0;
const CAMERA_POSITION_Y = 0.55;
const CAMERA_POSITION_Z = 3.4;
const CAMERA_LOOK_AT_Y = 0.05;

const WARM_LIGHT_BASE_INTENSITY = 0.5;
const WARM_LIGHT_FLICKER_STRONG = 0.08;
const WARM_LIGHT_FLICKER_SUBTLE = 0.05;
const WARM_LIGHT_FLICKER_RATE_STRONG = 7.3;
const WARM_LIGHT_FLICKER_RATE_SUBTLE = 11.7;

const CAMERA_SWAY_AMPLITUDE = 0.01;
const CAMERA_SWAY_RATE = 0.9;

const GROUND_RADIUS = 6;
const GROUND_SEGMENTS = 48;
const GROUND_Y = -1.05;

export class SceneController {
    private readonly scene: THREE.Scene;
    private readonly camera: THREE.PerspectiveCamera;
    private readonly ambientLight: THREE.AmbientLight;
    private readonly directionalLight: THREE.DirectionalLight;
    private readonly warmPointLight: THREE.PointLight;
    private readonly groundMesh: THREE.Mesh;
    private elapsedSeconds = 0;

    constructor() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(BACKGROUND_COLOR);
        this.scene.fog = new THREE.Fog(BACKGROUND_COLOR, FOG_NEAR, FOG_FAR);

        this.camera = new THREE.PerspectiveCamera(CAMERA_FIELD_OF_VIEW, 1, CAMERA_NEAR, CAMERA_FAR);
        this.camera.position.set(CAMERA_POSITION_X, CAMERA_POSITION_Y, CAMERA_POSITION_Z);
        this.camera.lookAt(CAMERA_POSITION_X, CAMERA_LOOK_AT_Y, 0);

        this.ambientLight = new THREE.AmbientLight(0x1a1226, 0.55);
        this.directionalLight = new THREE.DirectionalLight(0x8fa8ff, 0.4);
        this.directionalLight.position.set(-3, 4, -2);
        this.warmPointLight = new THREE.PointLight(0xff5a1e, WARM_LIGHT_BASE_INTENSITY, 8, 2);
        this.warmPointLight.position.set(2.5, 0.4, 1.5);

        const groundGeometry = new THREE.CircleGeometry(GROUND_RADIUS, GROUND_SEGMENTS);
        groundGeometry.rotateX(-Math.PI / 2);
        this.groundMesh = new THREE.Mesh(
            groundGeometry,
            new THREE.MeshStandardMaterial({ color: 0x140d08, roughness: 0.95 }),
        );
        this.groundMesh.position.y = GROUND_Y;

        this.scene.add(
            this.ambientLight,
            this.directionalLight,
            this.warmPointLight,
            this.groundMesh,
        );
    }

    addCharacter(root: THREE.Object3D): void {
        this.scene.add(root);
    }

    getScene(): THREE.Scene {
        return this.scene;
    }

    getCamera(): THREE.PerspectiveCamera {
        return this.camera;
    }

    setViewportSize(width: number, height: number): void {
        if (width <= 0 || height <= 0) {
            return;
        }
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    update(dtSeconds: number): void {
        this.elapsedSeconds += dtSeconds;
        const t = this.elapsedSeconds;

        this.warmPointLight.intensity =
            WARM_LIGHT_BASE_INTENSITY +
            WARM_LIGHT_FLICKER_STRONG * Math.sin(t * WARM_LIGHT_FLICKER_RATE_STRONG) +
            WARM_LIGHT_FLICKER_SUBTLE * Math.sin(t * WARM_LIGHT_FLICKER_RATE_SUBTLE);

        this.camera.position.y =
            CAMERA_POSITION_Y + CAMERA_SWAY_AMPLITUDE * Math.sin(t * CAMERA_SWAY_RATE);
    }

    dispose(): void {
        this.scene.traverse((object) => {
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
    }
}

"use client";
// A three.js render loop mutates the scene graph every frame by design — morph-target
// influences, bone rotations, light colours. That is exactly what React Compiler's
// immutability rule forbids, so this component opts out of it.
"use no memo";
/* eslint-disable react-hooks/immutability */

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

export type AvatarState = "idle" | "listening" | "thinking" | "speaking";

type Props = {
  /** 0-1 loudness of her current speech, updated every frame from the audio analyser. */
  mouthRef: React.RefObject<number>;
  state: AvatarState;
};

/**
 * Any GLB with ARKit blendshapes works — she is measured, scaled and framed on load.
 * Swap her for your own Ready Player Me avatar via NEXT_PUBLIC_AVATAR_URL:
 *   https://models.readyplayer.me/<id>.glb?morphTargets=ARKit&textureAtlas=1024
 */
const MODEL_URL = process.env.NEXT_PUBLIC_AVATAR_URL || "/avatar.glb";
const damp = THREE.MathUtils.damp;

/** Blendshape names differ between exporters — try every spelling we know of. */
const SHAPES = {
  jaw: ["jawOpen"],
  funnel: ["mouthFunnel"],
  close: ["mouthClose"],
  wide: ["viseme_aa"],
  round: ["viseme_O"],
  smile: ["mouthSmileLeft", "mouthSmileRight", "mouthSmile_L", "mouthSmile_R"],
  browInner: ["browInnerUp"],
  browOuter: ["browOuterUpLeft", "browOuterUpRight", "browOuterUp_L", "browOuterUp_R"],
  blink: ["eyeBlinkLeft", "eyeBlinkRight", "eyeBlink_L", "eyeBlink_R"],
  squint: ["eyeSquintLeft", "eyeSquintRight", "eyeSquint_L", "eyeSquint_R"],
  cheek: ["cheekSquintLeft", "cheekSquintRight", "cheekSquint_L", "cheekSquint_R"],
} as const;

type Morph = { mesh: THREE.Mesh; dict: Record<string, number> };
type Bones = { head?: THREE.Object3D; neck?: THREE.Object3D; spine?: THREE.Object3D };
type Loaded = {
  scene: THREE.Object3D;
  morphs: Morph[];
  bones: Bones;
  base: Record<string, THREE.Euler>;
  /** Where to point the camera, and how tall a slice of the world to show. */
  frame: { y: number; height: number };
};

/**
 * One loader, one load, for the life of the page — React StrictMode mounts effects
 * twice in development and the model is a few megabytes.
 */
let modelPromise: Promise<Loaded> | null = null;

function loadAvatar(): Promise<Loaded> {
  if (modelPromise) return modelPromise;

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  modelPromise = loader.loadAsync(MODEL_URL).then((gltf) => {
    const scene = gltf.scene;

    const morphs: Morph[] = [];
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.frustumCulled = false; // skinned meshes cull badly up close
      if (mesh.morphTargetInfluences && mesh.morphTargetDictionary) {
        morphs.push({ mesh, dict: mesh.morphTargetDictionary });
      }
    });

    // Normalise whatever scale the model ships with: total height = 1 unit, centred.
    scene.position.set(0, 0, 0);
    scene.scale.setScalar(1);
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (size.y > 1e-6) {
      const scale = 1 / size.y;
      scene.scale.setScalar(scale);
      scene.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    }
    scene.updateMatrixWorld(true);

    const bones: Bones = {
      head: scene.getObjectByName("Head"),
      neck: scene.getObjectByName("Neck"),
      spine: scene.getObjectByName("Spine2") ?? scene.getObjectByName("Spine1"),
    };
    const base: Record<string, THREE.Euler> = {};
    for (const [key, bone] of Object.entries(bones)) {
      if (bone) base[key] = bone.rotation.clone();
    }

    // Frame a head-and-shoulders portrait when there is a skeleton to measure;
    // fall back to the whole model for a head-only GLB.
    const headTop = scene.getObjectByName("HeadTop_End");
    let frame = { y: 0, height: Math.max(size.y, 1e-6) * 1.35 };
    if (bones.head) {
      const headY = bones.head.getWorldPosition(new THREE.Vector3()).y;
      const topY = headTop ? headTop.getWorldPosition(new THREE.Vector3()).y : headY + 0.12;
      const skull = Math.max(topY - headY, 1e-3);
      frame = { y: headY + skull * 0.42, height: skull * 3.05 };
    }

    return { scene, morphs, bones, base, frame };
  });

  return modelPromise;
}

function Head({ mouthRef, state, onFrame }: Props & { onFrame: (f: { y: number; height: number }) => void }) {
  const camera = useThree((s) => s.camera);
  const [model, setModel] = useState<THREE.Object3D | null>(null);
  const morphsRef = useRef<Morph[]>([]);
  const bonesRef = useRef<Bones>({});
  const baseRef = useRef<Record<string, THREE.Euler>>({});
  const pointer = useRef(new THREE.Vector2());
  const blink = useRef({ next: 2, closing: 0 });

  useEffect(() => {
    let cancelled = false;
    loadAvatar()
      .then((loaded) => {
        if (cancelled) return;
        morphsRef.current = loaded.morphs;
        bonesRef.current = loaded.bones;
        baseRef.current = loaded.base;

        const perspective = camera as THREE.PerspectiveCamera;
        const distance =
          loaded.frame.height / (2 * Math.tan(((perspective.fov ?? 30) * Math.PI) / 360));
        camera.position.set(0, loaded.frame.y, distance);
        camera.lookAt(0, loaded.frame.y, 0);
        camera.updateProjectionMatrix();

        onFrame(loaded.frame);
        setModel(loaded.scene);
      })
      .catch((err) => console.error("Avatar model failed to load:", err));
    return () => {
      cancelled = true;
    };
  }, [camera, onFrame]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      );
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const t = performance.now() / 1000;

    // --- blinking: a quick close/open every few seconds ---------------------
    const b = blink.current;
    b.next -= delta;
    if (b.next <= 0) {
      b.closing = 1;
      b.next = 2.5 + Math.random() * 3.5;
    }
    b.closing = Math.max(0, b.closing - delta * 7);
    const lid = Math.sin(Math.min(b.closing, 1) * Math.PI);

    // --- mouth: driven by the loudness of her actual voice ------------------
    const loud = state === "speaking" ? THREE.MathUtils.clamp(mouthRef.current ?? 0, 0, 1) : 0;
    // Vowel shape wanders a little so it does not read as a flapping hinge.
    const roundness = (Math.sin(t * 5.3) * 0.5 + 0.5) * loud;
    const smile = state === "idle" ? 0.18 : state === "listening" ? 0.3 : 0.12;
    const brow = state === "listening" ? 0.28 : state === "thinking" ? 0.14 : 0.05;

    for (const { mesh, dict } of morphsRef.current) {
      const inf = mesh.morphTargetInfluences;
      if (!inf) continue;
      const set = (names: readonly string[], value: number, lambda = 12) => {
        for (const name of names) {
          const i = dict[name];
          if (i !== undefined) inf[i] = damp(inf[i], value, lambda, delta);
        }
      };
      set(SHAPES.jaw, loud * 0.55, 18);
      set(SHAPES.wide, loud * 0.45 * (1 - roundness), 18);
      set(SHAPES.round, roundness * 0.4, 16);
      set(SHAPES.funnel, roundness * 0.25, 16);
      set(SHAPES.close, loud > 0.02 ? 0 : 0.05);
      set(SHAPES.smile, smile);
      set(SHAPES.browInner, brow);
      set(SHAPES.browOuter, brow * 0.6);
      set(SHAPES.blink, lid, 30);
      set(SHAPES.squint, smile * 0.35);
      set(SHAPES.cheek, loud * 0.2);
    }

    // --- she turns her head toward your cursor, and breathes ----------------
    const { head, neck, spine } = bonesRef.current;
    const base = baseRef.current;
    const swayY = Math.sin(t * 0.45) * 0.05 + Math.sin(t * 0.21) * 0.03;
    const swayX = Math.sin(t * 0.37) * 0.02;
    const tilt = state === "thinking" ? 0.1 : Math.sin(t * 0.3) * 0.02;

    if (head && base.head) {
      head.rotation.y = damp(head.rotation.y, base.head.y + swayY + pointer.current.x * 0.3, 3, delta);
      head.rotation.x = damp(head.rotation.x, base.head.x + swayX - pointer.current.y * 0.18, 3, delta);
      head.rotation.z = damp(head.rotation.z, base.head.z + tilt, 3, delta);
    }
    if (neck && base.neck) {
      neck.rotation.y = damp(neck.rotation.y, base.neck.y + pointer.current.x * 0.12, 3, delta);
      neck.rotation.x = damp(neck.rotation.x, base.neck.x - pointer.current.y * 0.07, 3, delta);
    }
    if (spine && base.spine) {
      spine.rotation.x = damp(spine.rotation.x, base.spine.x + Math.sin(t * 0.7) * 0.012, 4, delta);
    }
  });

  return model ? <primitive object={model} /> : null;
}

function Lights({ state }: { state: AvatarState }) {
  const rim = useRef<THREE.PointLight>(null);
  const tint = state === "listening" ? "#7dd3fc" : state === "speaking" ? "#c4b5fd" : "#94a3b8";

  useFrame((_, delta) => {
    if (rim.current) rim.current.color.lerp(new THREE.Color(tint), Math.min(delta * 3, 1));
  });

  return (
    <>
      <ambientLight intensity={0.65} />
      <directionalLight position={[0.6, 1.2, 1.4]} intensity={1.5} color="#ffeede" />
      <directionalLight position={[-1.4, 0.5, 0.8]} intensity={0.5} color="#a9c4ff" />
      <pointLight ref={rim} position={[0, 0.4, -1.2]} intensity={1.4} distance={5} color={tint} />
    </>
  );
}

/** Soft pulsing halo behind her — readable in peripheral vision while driving. */
function Halo({
  state,
  mouthRef,
  frame,
}: Props & { frame: { y: number; height: number } | null }) {
  const mesh = useRef<THREE.Mesh>(null);
  const color = state === "listening" ? "#38bdf8" : state === "thinking" ? "#fbbf24" : "#818cf8";

  useFrame((_, delta) => {
    if (!mesh.current) return;
    const t = performance.now() / 1000;
    const pulse =
      state === "speaking"
        ? 1 + (mouthRef.current ?? 0) * 0.3
        : state === "listening"
          ? 1 + Math.sin(t * 3) * 0.04
          : 1 + Math.sin(t * 1.2) * 0.02;
    mesh.current.scale.setScalar(damp(mesh.current.scale.x, pulse, 10, delta));
    (mesh.current.material as THREE.MeshBasicMaterial).color.lerp(
      new THREE.Color(color),
      Math.min(delta * 3, 1),
    );
  });

  if (!frame) return null;
  return (
    <mesh ref={mesh} position={[0, frame.y, -frame.height * 1.3]}>
      <circleGeometry args={[frame.height * 0.5, 64]} />
      <meshBasicMaterial color={color} transparent opacity={0.16} />
    </mesh>
  );
}

export default function Avatar({ mouthRef, state }: Props) {
  const [frame, setFrame] = useState<{ y: number; height: number } | null>(null);

  return (
    <Canvas
      camera={{ position: [0, 0, 2], fov: 26, near: 0.01, far: 100 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      style={{ touchAction: "none" }}
    >
      <Lights state={state} />
      <Halo state={state} mouthRef={mouthRef} frame={frame} />
      <Head mouthRef={mouthRef} state={state} onFrame={setFrame} />
    </Canvas>
  );
}

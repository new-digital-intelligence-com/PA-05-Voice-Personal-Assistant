"use client";
// A three.js render loop mutates the scene graph every frame by design — morph-target
// influences, transforms, light colours. That is exactly what React Compiler's
// immutability rule forbids, so this component opts out of it.
"use no memo";
/* eslint-disable react-hooks/immutability */

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

export type AvatarState = "idle" | "listening" | "thinking" | "speaking";

type Props = {
  /** 0-1 loudness of her current speech, updated every frame from the audio analyser. */
  mouthRef: React.RefObject<number>;
  state: AvatarState;
};

/**
 * Defaults to the bundled head (works offline, ships with all 52 ARKit blendshapes).
 * Point NEXT_PUBLIC_AVATAR_URL at any GLB with ARKit morph targets to swap her —
 * e.g. a Ready Player Me avatar:
 *   https://models.readyplayer.me/<id>.glb?morphTargets=ARKit&textureAtlas=1024
 */
const MODEL_URL = process.env.NEXT_PUBLIC_AVATAR_URL || "/avatar.glb";
const damp = THREE.MathUtils.damp;

type Morph = { mesh: THREE.Mesh; dict: Record<string, number> };

/**
 * One loader, one load, for the life of the page. React StrictMode mounts effects
 * twice in development, and KTX2Loader shares a worker pool — creating and disposing
 * one per mount leaves the second load waiting on a transcoder that is already gone.
 */
let modelPromise: Promise<THREE.Object3D> | null = null;

function loadAvatar(gl: THREE.WebGLRenderer): Promise<THREE.Object3D> {
  if (modelPromise) return modelPromise;

  const ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(gl);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.setKTX2Loader(ktx2);

  modelPromise = loader.loadAsync(MODEL_URL).then((gltf) => {
    const scene = gltf.scene;

    const morphs: Morph[] = [];
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.morphTargetInfluences && mesh.morphTargetDictionary) {
        morphs.push({ mesh, dict: mesh.morphTargetDictionary });
      }
    });
    scene.userData.morphs = morphs;

    // Normalise whatever scale the model ships with: head height = 1 unit,
    // centred on the origin, so camera framing never depends on the source file.
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
    return scene;
  });

  return modelPromise;
}

function Head({ mouthRef, state }: Props) {
  const gl = useThree((s) => s.gl);
  const [model, setModel] = useState<THREE.Object3D | null>(null);
  const group = useRef<THREE.Group>(null);
  const morphsRef = useRef<Morph[]>([]);
  const pointer = useRef(new THREE.Vector2());
  const blink = useRef({ next: 2, closing: 0 });

  useEffect(() => {
    let cancelled = false;
    loadAvatar(gl)
      .then((scene) => {
        if (cancelled) return;
        morphsRef.current = (scene.userData.morphs as Morph[]) ?? [];
        setModel(scene);
      })
      .catch((err) => console.error("Avatar model failed to load:", err));
    return () => {
      cancelled = true;
    };
  }, [gl]);

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

    // --- blinking: a quick close/open every few seconds --------------------
    const b = blink.current;
    b.next -= delta;
    if (b.next <= 0) {
      b.closing = 1;
      b.next = 2.5 + Math.random() * 3.5;
    }
    b.closing = Math.max(0, b.closing - delta * 7);
    const lid = Math.sin(Math.min(b.closing, 1) * Math.PI);

    // --- mouth: driven by the loudness of her actual voice -----------------
    const loud = state === "speaking" ? THREE.MathUtils.clamp(mouthRef.current ?? 0, 0, 1) : 0;
    const smile = state === "idle" ? 0.16 : state === "listening" ? 0.26 : 0.1;
    const brow = state === "listening" ? 0.3 : state === "thinking" ? 0.14 : 0.05;

    for (const { mesh, dict } of morphsRef.current) {
      const inf = mesh.morphTargetInfluences;
      if (!inf) continue;
      const set = (name: string, value: number, lambda = 12) => {
        const i = dict[name];
        if (i !== undefined) inf[i] = damp(inf[i], value, lambda, delta);
      };
      set("jawOpen", loud * 0.62, 18);
      set("mouthFunnel", loud * 0.35, 16);
      set("mouthClose", loud > 0.02 ? 0 : 0.08);
      set("mouthSmile_L", smile);
      set("mouthSmile_R", smile);
      set("browInnerUp", brow);
      set("browOuterUp_L", brow * 0.6);
      set("browOuterUp_R", brow * 0.6);
      set("eyeBlink_L", lid, 30);
      set("eyeBlink_R", lid, 30);
      set("eyeSquint_L", smile * 0.4);
      set("eyeSquint_R", smile * 0.4);
      set("cheekSquint_L", loud * 0.2);
      set("cheekSquint_R", loud * 0.2);
    }

    // --- head: breathing sway, and she turns toward your cursor ------------
    const root = group.current;
    if (root) {
      const targetY = Math.sin(t * 0.45) * 0.05 + Math.sin(t * 0.21) * 0.03 + pointer.current.x * 0.16;
      const targetX =
        Math.sin(t * 0.37) * 0.025 - pointer.current.y * 0.1 + (state === "thinking" ? 0.05 : 0);
      const tilt = state === "thinking" ? 0.09 : Math.sin(t * 0.3) * 0.015;
      root.rotation.y = damp(root.rotation.y, targetY, 3, delta);
      root.rotation.x = damp(root.rotation.x, targetX, 3, delta);
      root.rotation.z = damp(root.rotation.z, tilt, 3, delta);
      root.position.y = damp(root.position.y, Math.sin(t * 0.8) * 0.006, 4, delta);
    }
  });

  return <group ref={group}>{model && <primitive object={model} />}</group>;
}

function Lights({ state }: { state: AvatarState }) {
  const rim = useRef<THREE.PointLight>(null);
  const tint = state === "listening" ? "#7dd3fc" : state === "speaking" ? "#c4b5fd" : "#94a3b8";

  useFrame((_, delta) => {
    if (rim.current) rim.current.color.lerp(new THREE.Color(tint), Math.min(delta * 3, 1));
  });

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[1.2, 1.5, 2.6]} intensity={1.35} color="#ffe9d2" />
      <directionalLight position={[-2.2, 0.3, 1.0]} intensity={0.4} color="#a9c4ff" />
      <pointLight ref={rim} position={[0, 0.7, -1.8]} intensity={2} distance={7} color={tint} />
    </>
  );
}

/** Soft pulsing halo behind her — readable in peripheral vision while driving. */
function Halo({ state, mouthRef }: Props) {
  const mesh = useRef<THREE.Mesh>(null);
  const color = state === "listening" ? "#38bdf8" : state === "thinking" ? "#fbbf24" : "#818cf8";

  useFrame((_, delta) => {
    if (!mesh.current) return;
    const t = performance.now() / 1000;
    const pulse =
      state === "speaking"
        ? 1 + (mouthRef.current ?? 0) * 0.35
        : state === "listening"
          ? 1 + Math.sin(t * 3) * 0.05
          : 1 + Math.sin(t * 1.2) * 0.02;
    mesh.current.scale.setScalar(damp(mesh.current.scale.x, pulse, 10, delta));
    const material = mesh.current.material as THREE.MeshBasicMaterial;
    material.color.lerp(new THREE.Color(color), Math.min(delta * 3, 1));
  });

  return (
    <mesh ref={mesh} position={[0, -0.02, -1.4]}>
      <circleGeometry args={[0.62, 64]} />
      <meshBasicMaterial color={color} transparent opacity={0.16} />
    </mesh>
  );
}

export default function Avatar({ mouthRef, state }: Props) {
  return (
    <Canvas
      camera={{ position: [0, 0.03, 2.45], fov: 30 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      style={{ touchAction: "none" }}
    >
      <Lights state={state} />
      <Halo state={state} mouthRef={mouthRef} />
      <Head mouthRef={mouthRef} state={state} />
    </Canvas>
  );
}

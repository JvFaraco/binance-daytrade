// A esfera do Time Machine. Um único LineSegments com todos os fios; a posição de cada ponto e a
// cor de cada fio são calculadas no shader, então arrastar o custo recolore tudo sem tocar na geometria.
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import * as fmt from "../app/format";
import { useSettings } from "../state/settings";
import { prefersReducedMotion } from "../ui/motion";
import { tokens } from "../ui/useCanvas";
import { LAT_MAX, POINT_STRIDE, SWEEP, type SphereBuffers, latitudeOf, pointOnSphere } from "./geometry";
import { useSphereHover } from "./hover";

export interface SceneProps {
  buffers: SphereBuffers;
  /** 2 * entrada / risco: transforma custo percentual em R */
  k: number;
  targetR: number;
  /** falso quando o painel está fora da tela ou a aba está escondida: para de desenhar */
  active: boolean;
  /** contêiner dos rótulos dos anéis (elementos com data-ring), posicionados a cada quadro */
  labels: RefObject<HTMLDivElement | null>;
}

const VERT = /* glsl */ `
  attribute vec2 aExtra;            // progresso no fio (0..1), R bruto de saída do fio
  uniform float uSweep;
  uniform float uLatMax;
  uniform float uRScale;
  uniform float uCost;              // custo por lado, fração (0.0015 = 0,15%)
  uniform float uK;                 // 2 * entrada / risco
  uniform float uReveal;
  uniform float uAlpha;
  uniform vec3 uPos;
  uniform vec3 uNeg;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float tau = position.x;
    float lon = position.z + tau * uSweep;
    float lat = clamp(position.y / uRScale, -1.25, 1.25) * uLatMax;
    float cl = cos(lat);
    vec3 p = vec3(cl * cos(lon), sin(lat), cl * sin(lon));

    // R líquido do fio: o mesmo core.net_r, escrito a partir do R bruto de saída
    float net = aExtra.y * (1.0 - uCost) - uCost * uK;
    vec3 c = mix(uNeg, uPos, smoothstep(-0.04, 0.04, net));
    // brilho pelo tamanho do resultado: com custo, os ganhos encolhem e apagam; as perdas crescem e acendem
    float strength = 0.22 + 1.05 * pow(clamp(abs(net) / 1.5, 0.0, 1.35), 1.5);

    // fios do lado de trás aparecem mais fracos: dá volume sem esconder o acúmulo
    vec3 n = normalize(normalMatrix * p);
    float facing = mix(0.14, 1.0, smoothstep(-0.2, 0.7, n.z));

    vColor = c * strength;
    vAlpha = uAlpha * facing * mix(0.3, 1.0, aExtra.x) * (1.0 - smoothstep(uReveal - 0.04, uReveal, tau));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.002) discard;
    gl_FragColor = vec4(vColor * vAlpha, 1.0);
  }
`;

function circle(segments = 160): THREE.BufferGeometry {
  const pts = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts[i * 3] = Math.cos(a);
    pts[i * 3 + 2] = Math.sin(a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  return g;
}

function Threads({ buffers, k }: SceneProps) {
  const T = tokens();
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uSweep: { value: SWEEP },
          uLatMax: { value: LAT_MAX },
          uRScale: { value: 1 },
          uCost: { value: useSettings.getState().cost_pct / 100 },
          uK: { value: 1 },
          uReveal: { value: 0 },
          uAlpha: { value: 0.1 },
          uPos: { value: new THREE.Color(T.pos) },
          uNeg: { value: new THREE.Color(T.neg) },
        },
      }),
    [T.pos, T.neg],
  );
  const lines = useMemo(() => {
    const l = new THREE.LineSegments(new THREE.BufferGeometry(), material);
    l.frustumCulled = false;
    return l;
  }, [material]);
  const capacity = useRef({ points: 0, index: 0 });
  const invalidate = useThree((s) => s.invalidate);

  // resultado novo do worker: copia para os buffers já alocados (só realoca se não couber)
  useEffect(() => {
    let g = lines.geometry;
    const needP = buffers.points.length;
    const needI = buffers.index.length;
    if (needP > capacity.current.points || needI > capacity.current.index) {
      g.dispose();
      g = new THREE.BufferGeometry();
      const capP = Math.ceil((needP * 1.15) / POINT_STRIDE) * POINT_STRIDE;
      const capI = Math.ceil(needI * 1.15);
      const ib = new THREE.InterleavedBuffer(new Float32Array(capP), POINT_STRIDE);
      ib.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("position", new THREE.InterleavedBufferAttribute(ib, 3, 0));
      g.setAttribute("aExtra", new THREE.InterleavedBufferAttribute(ib, 2, 3));
      const idx = new THREE.BufferAttribute(new Uint32Array(capI), 1);
      idx.setUsage(THREE.DynamicDrawUsage);
      g.setIndex(idx);
      lines.geometry = g;
      capacity.current = { points: capP, index: capI };
    }
    const ib = (g.getAttribute("position") as THREE.InterleavedBufferAttribute).data;
    (ib.array as Float32Array).set(buffers.points);
    ib.needsUpdate = true;
    const idx = g.getIndex() as THREE.BufferAttribute;
    (idx.array as Uint32Array).set(buffers.index);
    idx.needsUpdate = true;
    g.setDrawRange(0, needI);
    material.uniforms.uRScale.value = buffers.rScale;
    // mais fios desenhados -> cada um mais transparente, para o acúmulo não estourar
    material.uniforms.uAlpha.value = Math.max(0.035, Math.min(0.4, 330 / buffers.drawn));
    material.uniforms.uReveal.value = prefersReducedMotion() ? 1.05 : 0;
    invalidate();
  }, [buffers, lines, material, invalidate]);

  useEffect(() => {
    material.uniforms.uK.value = k;
  }, [k, material]);

  useEffect(
    () => () => {
      lines.geometry.dispose();
      material.dispose();
    },
    [lines, material],
  );

  // o custo persegue o controle a cada quadro: a cor muda enquanto o controle é arrastado
  useFrame((_, dt) => {
    const u = material.uniforms;
    const target = useSettings.getState().cost_pct / 100;
    const cur = u.uCost.value as number;
    u.uCost.value = Math.abs(target - cur) < 1e-7 ? target : cur + (target - cur) * Math.min(1, dt * 14);
    if (u.uReveal.value < 1.05) u.uReveal.value = Math.min(1.05, u.uReveal.value + dt / 1.4);
  });

  return <primitive object={lines} />;
}

/** Anéis de referência: entrada (equador), alvo, stop e a linha de empate, que sobe com o custo. */
function Rings({ k, targetR, rScale, labels }: { k: number; targetR: number; rScale: number; labels: SceneProps["labels"] }) {
  const T = tokens();
  const objects = useMemo(() => {
    const geo = circle();
    const mk = (color: string, opacity: number) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, blending: THREE.AdditiveBlending });
    const ring = (r: number, mat: THREE.Material) => {
      const lat = latitudeOf(r, rScale);
      const l = new THREE.LineLoop(geo, mat);
      l.position.y = Math.sin(lat);
      l.scale.set(Math.cos(lat), 1, Math.cos(lat));
      return l;
    };
    const rule = mk(T.line2, 0.9);
    // régua: um anel fraco a cada 0,5R
    const rules: THREE.LineLoop[] = [];
    for (let r = -1; r <= targetR + 1e-9; r += 0.5) {
      if (Math.abs(r) > 1e-9 && Math.abs(r + 1) > 1e-9 && Math.abs(r - targetR) > 1e-9) rules.push(ring(r, rule));
    }
    return {
      geo,
      rules,
      fixed: [
        { key: "target", r: targetR, line: ring(targetR, mk(T.pos, 0.55)) },
        { key: "entry", r: 0, line: ring(0, mk(T.signal, 0.8)) },
        { key: "stop", r: -1, line: ring(-1, mk(T.neg, 0.55)) },
      ],
      even: new THREE.LineLoop(geo, mk(T.tx1, 0.9)),
    };
  }, [targetR, rScale, T.line2, T.pos, T.signal, T.neg, T.tx1]);
  const cost = useRef(useSettings.getState().cost_pct / 100);
  const v = useMemo(() => new THREE.Vector3(), []);

  useEffect(
    () => () => {
      objects.geo.dispose();
    },
    [objects],
  );

  useFrame(({ camera, size }, dt) => {
    const target = useSettings.getState().cost_pct / 100;
    cost.current = Math.abs(target - cost.current) < 1e-7 ? target : cost.current + (target - cost.current) * Math.min(1, dt * 14);
    const c = cost.current;
    // R bruto que empata: net = g(1-c) - cK = 0
    const g = (c * k) / (1 - c);
    const lat = latitudeOf(g, rScale);
    objects.even.position.y = Math.sin(lat);
    objects.even.scale.set(Math.cos(lat), 1, Math.cos(lat));

    // rótulos em DOM na borda direita da esfera, vistos da câmera
    const box = labels.current;
    if (!box) return;
    const az = Math.atan2(camera.position.x, camera.position.z);
    const rx = Math.cos(az);
    const rz = -Math.sin(az);
    const place = (key: string, r: number) => {
      const el = box.querySelector<HTMLElement>(`[data-ring="${key}"]`);
      if (!el) return null;
      const la = latitudeOf(r, rScale);
      v.set(rx * Math.cos(la) * 1.05, Math.sin(la), rz * Math.cos(la) * 1.05).project(camera);
      el.style.transform = `translate(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((0.5 - v.y * 0.5) * size.height).toFixed(1)}px) translateY(-50%)`;
      el.style.opacity = "1";
      return el;
    };
    for (const f of objects.fixed) {
      const el = place(f.key, f.r);
      // o empate passa por cima da entrada quando o custo é quase zero: some com o rótulo de baixo
      if (el && f.key === "entry" && Math.abs(g) < 0.14) el.style.opacity = "0";
    }
    const ev = place("even", g);
    if (ev) {
      const txt = g > targetR ? `empate ${fmt.rr(g)} · acima do alvo` : `empate ${fmt.rr(g)}`;
      if (ev.textContent !== txt) ev.textContent = txt;
    }
  });

  return (
    <>
      {objects.rules.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
      {objects.fixed.map((f) => (
        <primitive key={f.key} object={f.line} />
      ))}
      <primitive object={objects.even} />
    </>
  );
}

/** O fio destacado e a busca do fio mais perto do ponteiro. */
function Picker({ buffers }: { buffers: SphereBuffers }) {
  const T = tokens();
  const { camera, gl, invalidate } = useThree();
  const hover = useSphereHover((s) => s.hover);
  const SAMPLES = 6;

  // alguns pontos de cada fio, já na esfera, para medir a distância ao ponteiro
  const samples = useMemo(() => {
    const out = new Float32Array(buffers.drawn * SAMPLES * 3);
    for (let d = 0; d < buffers.drawn; d++) {
      const n = buffers.pathCount[d];
      for (let s = 0; s < SAMPLES; s++) {
        const j = Math.min(n - 1, Math.round(((s + 1) / SAMPLES) * (n - 1)));
        const k = (buffers.pathStart[d] + j) * POINT_STRIDE;
        pointOnSphere(buffers.points[k], buffers.points[k + 1], buffers.points[k + 2], buffers.rScale, out, (d * SAMPLES + s) * 3);
      }
    }
    return out;
  }, [buffers]);

  const line = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buffers.pathLen * 3), 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: T.signal, transparent: true, depthTest: false }));
    l.frustumCulled = false;
    l.visible = false;
    l.renderOrder = 10;
    return l;
  }, [buffers.pathLen, T.signal]);
  const dot = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const d = hover?.drawn;
    if (d === undefined || d >= buffers.drawn) {
      line.visible = false;
      if (dot.current) dot.current.visible = false;
      invalidate();
      return;
    }
    const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const n = buffers.pathCount[d];
    for (let j = 0; j < n; j++) {
      const k = (buffers.pathStart[d] + j) * POINT_STRIDE;
      pointOnSphere(buffers.points[k], buffers.points[k + 1], buffers.points[k + 2], buffers.rScale, arr, j * 3);
      arr[j * 3] *= 1.006;
      arr[j * 3 + 1] *= 1.006;
      arr[j * 3 + 2] *= 1.006;
    }
    pos.needsUpdate = true;
    line.geometry.setDrawRange(0, n);
    line.visible = true;
    if (dot.current) {
      dot.current.visible = true;
      dot.current.position.set(arr[(n - 1) * 3], arr[(n - 1) * 3 + 1], arr[(n - 1) * 3 + 2]);
    }
    invalidate();
  }, [hover?.drawn, buffers, line, invalidate]);

  useEffect(() => {
    const el = gl.domElement;
    let raf = 0;
    let last: PointerEvent | null = null;
    const m = new THREE.Matrix4();
    const cam = new THREE.Vector3();
    const pick = () => {
      raf = 0;
      const ev = last;
      if (!ev) return;
      const rect = el.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const e = m.elements;
      cam.copy(camera.position).normalize();
      let best = -1;
      let bestD = 14 * 14; // raio de captura em px
      const total = buffers.drawn * SAMPLES;
      for (let i = 0; i < total; i++) {
        const x = samples[i * 3];
        const y = samples[i * 3 + 1];
        const z = samples[i * 3 + 2];
        if (x * cam.x + y * cam.y + z * cam.z < 0.05) continue; // lado de trás
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5;
        const sy = 0.5 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5;
        const dx = sx * rect.width - px;
        const dy = sy * rect.height - py;
        const dd = dx * dx + dy * dy;
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      const cur = useSphereHover.getState().hover;
      if (best < 0) {
        if (cur && cur.x !== null) useSphereHover.setState({ hover: null });
        return;
      }
      const d = Math.floor(best / SAMPLES);
      useSphereHover.setState({ hover: { drawn: d, replay: buffers.pathReplay[d], x: px, y: py } });
    };
    const move = (ev: PointerEvent) => {
      if (ev.buttons) return; // arrastando: está girando, não apontando
      last = ev;
      if (!raf) raf = requestAnimationFrame(pick);
    };
    const leave = () => {
      last = null;
      const cur = useSphereHover.getState().hover;
      if (cur && cur.x !== null) useSphereHover.setState({ hover: null });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(raf);
    };
  }, [gl, camera, samples, buffers]);

  return (
    <>
      <primitive object={line} />
      <mesh ref={dot} visible={false} renderOrder={11}>
        <sphereGeometry args={[0.018, 12, 12]} />
        <meshBasicMaterial color={T.signal} depthTest={false} />
      </mesh>
    </>
  );
}

export default function SphereScene(props: SceneProps) {
  const reduce = prefersReducedMotion();
  const small = props.buffers.drawn <= 2500;
  return (
    <Canvas
      className="sphere__canvas"
      frameloop={props.active ? "always" : "never"}
      dpr={[1, small ? 1.5 : 1.75]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ fov: 30, position: [0, 0.85, 4.4], near: 0.1, far: 20 }}
      onCreated={({ gl }) => gl.setClearColor(tokens().bg1, 1)}
    >
      <Threads {...props} />
      <Rings k={props.k} targetR={props.targetR} rScale={props.buffers.rScale} labels={props.labels} />
      <Picker buffers={props.buffers} />
      <OrbitControls enablePan={false} enableZoom={false} autoRotate={!reduce} autoRotateSpeed={0.55} minPolarAngle={Math.PI * 0.28} maxPolarAngle={Math.PI * 0.72} rotateSpeed={0.6} enableDamping dampingFactor={0.08} />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={small ? 0.4 : 0.55} luminanceThreshold={0.3} luminanceSmoothing={0.4} radius={0.6} />
      </EffectComposer>
    </Canvas>
  );
}

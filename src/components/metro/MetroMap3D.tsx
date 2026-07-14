'use client';

/* ============================================================
   NAMMA METRO — 3D view (three.js)

   The same network, service simulation and timetable as the 2D
   map, lifted into 3D: elevated lines run on viaducts carried by
   pillars, the city-core tunnel sections dive below a translucent
   ground plane, and multi-coach trains ride the tracks on the
   real IST schedule. Orbit to explore; toggle day/night.

   Everything scene-shaped lives in one setup effect; the React
   layer only owns the HTML chrome (toolbar, status).
   ============================================================ */

import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise, ArrowLeft, Moon, Sun } from '@phosphor-icons/react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { lineData, buildStationMap, TUNNELS, MAP_CX, MAP_CY, type Point } from '@/metro/data';
import { buildGeometry, roundCorners, type Geometry } from '@/metro/geometry';
import { buildProfile, currentHeadway, poolSize, trainStateAt, returnPhase, BOARD_VIS, COMPRESS, istHour, SERVICE_START, SERVICE_END, isPeak, autoNight, twilightStrength, type Profile } from '@/metro/service';

const EL = 16;        // viaduct height
const UG = -14;       // tunnel depth
const RAMP = 80;      // portal ramp length along the track
const TRACK_OFFSET = 4;
const TRACK_W = 2.2;
const COACH_SPACING = 9.7;

const DAY = {
  bg: 0xf7f6f3, ground: 0xffffff, grid: 0xe3e1dc, hemi: 0.95, sun: 0.9,
  pillar: 0xd8d5cf, platform: 0xffffff, trackMul: 1.0, emissive: 0,
};
const NIGHT = {
  bg: 0x0b0f1c, ground: 0x0d1322, grid: 0x1a2133, hemi: 0.25, sun: 0.12,
  pillar: 0x2a3040, platform: 0x1a2030, trackMul: 0.62, emissive: 0.55,
};

function smooth(t: number) { return t * t * (3 - 2 * t); }

interface LineRuntime {
  geo: Geometry;
  profile: Profile;
  pool: number;
  ranges: [number, number][];
  cfg: (typeof lineData)[number]['cfg'];
}

export default function MetroMap3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  /** Theme follows the Bengaluru sky until the user toggles manually. */
  const [themeMode, setThemeMode] = useState<'auto' | 'day' | 'night'>('auto');
  const applyThemeRef = useRef<(n: boolean) => void>(() => {});
  const resetViewRef = useRef<() => void>(() => {});
  const [svcNow, setSvcNow] = useState<Date | null>(null);

  const clockH = svcNow ? istHour(svcNow) : null;
  const night = themeMode === 'auto' ? clockH != null && autoNight(clockH) : themeMode === 'night';
  const twilight = themeMode === 'auto' && clockH != null ? twilightStrength(clockH) : 0;
  const nightRef = useRef(night);

  useEffect(() => {
    // Live clock, started post-hydration (the prerendered markup must not
    // depend on the viewer's time).
    const t = setTimeout(() => setSvcNow(new Date()), 0);
    const iv = setInterval(() => setSvcNow(new Date()), 30_000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, []);

  useEffect(() => {
    nightRef.current = night;
    applyThemeRef.current(night);
  }, [night]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    /* ---------- runtime data (mirrors the 2D map) ---------- */
    const stationMap = buildStationMap();
    const lines: LineRuntime[] = lineData.map(ld => {
      const dense = roundCorners(ld.points as Point[], 18);
      const geo = buildGeometry(dense, ld.cfg.loop);
      const dists = ld.stations.map(sd => {
        const s = stationMap.get(sd.id)!;
        return geo.distanceOf(s.x, s.y);
      });
      const profile = buildProfile(dists);
      const ranges: [number, number][] = TUNNELS
        .filter(tn => tn.line === ld.cfg.id)
        .map(tn => {
          const dOf = (id: string) => { const s = stationMap.get(id)!; return geo.distanceOf(s.x, s.y); };
          let a = dOf(tn.from), b = dOf(tn.to);
          if (a > b) [a, b] = [b, a];
          return [Math.max(0, a - tn.pad), Math.min(geo.total, b + tn.pad)];
        });
      return { geo, profile, pool: poolSize(profile, ld.cfg), ranges, cfg: ld.cfg };
    });

    const elevAt = (li: number, d: number): number => {
      for (const [a, b] of lines[li].ranges) {
        if (d >= a && d <= b) return UG;
        if (d >= a - RAMP && d < a) return EL + (UG - EL) * smooth((d - (a - RAMP)) / RAMP);
        if (d > b && d <= b + RAMP) return UG + (EL - UG) * smooth((d - b) / RAMP);
      }
      return EL;
    };

    /* ---------- renderer / scene / camera ---------- */
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 1, 9000);
    camera.position.set(MAP_CX + 260, 1050, MAP_CY + 1150);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(MAP_CX, 0, MAP_CY);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 60;
    controls.maxDistance = 3200;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x99a1b3, DAY.hemi);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, DAY.sun);
    sun.position.set(600, 900, 300);
    scene.add(sun);

    /* ---------- ground (translucent, tunnels show through) ---------- */
    const groundMat = new THREE.MeshLambertMaterial({
      color: DAY.ground, transparent: true, opacity: 0.82, depthWrite: false,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.renderOrder = 2; // draw after tunnel content so blending dims it
    scene.add(ground);

    const grid = new THREE.GridHelper(4400, 88, DAY.grid, DAY.grid);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.set(MAP_CX, 0.4, MAP_CY);
    scene.add(grid);

    /* ---------- track ribbons (one per line per direction) ---------- */
    const trackMats: { mat: THREE.MeshBasicMaterial; base: THREE.Color }[] = [];
    lines.forEach((L, li) => {
      const base = new THREE.Color(L.cfg.color);
      [TRACK_OFFSET, -TRACK_OFFSET].forEach(off => {
        const positions: number[] = [];
        const indices: number[] = [];
        const step = 6;
        const n = Math.ceil(L.geo.total / step);
        for (let i = 0; i <= n; i++) {
          // Clamp just short of total — posAt() wraps at exactly `total`,
          // which would stitch the ribbon's end back to the line's start.
          const d = Math.min(i * step, L.geo.total - 0.01);
          const p = L.geo.posAt(d);
          const rad = p.angle * Math.PI / 180;
          const nx = Math.sin(rad), nz = -Math.cos(rad);
          const y = elevAt(li, d);
          const cx = p.x + nx * off, cz = p.y + nz * off;
          positions.push(cx + nx * (TRACK_W / 2), y, cz + nz * (TRACK_W / 2));
          positions.push(cx - nx * (TRACK_W / 2), y, cz - nz * (TRACK_W / 2));
          if (i < n) {
            const b = i * 2;
            indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setIndex(indices);
        const mat = new THREE.MeshBasicMaterial({ color: base.clone(), side: THREE.DoubleSide });
        trackMats.push({ mat, base });
        scene.add(new THREE.Mesh(g, mat));
      });
    });

    /* ---------- viaduct pillars ---------- */
    const pillarPositions: { x: number; z: number; h: number; rot: number }[] = [];
    lines.forEach((L, li) => {
      for (let d = 30; d < L.geo.total; d += 55) {
        const y = elevAt(li, d);
        if (y < EL - 0.5) continue; // no pillars on ramps/tunnels
        const p = L.geo.posAt(d);
        pillarPositions.push({ x: p.x, z: p.y, h: y, rot: p.angle * Math.PI / 180 });
      }
    });
    const pillarGeo = new THREE.BoxGeometry(2.4, 1, 1.6);
    const pillarMat = new THREE.MeshLambertMaterial({ color: DAY.pillar });
    const pillars = new THREE.InstancedMesh(pillarGeo, pillarMat, pillarPositions.length);
    const m4 = new THREE.Matrix4();
    pillarPositions.forEach((pp, i) => {
      m4.makeRotationY(-pp.rot);
      m4.setPosition(pp.x, pp.h / 2, pp.z);
      m4.scale(new THREE.Vector3(1, pp.h, 1));
      pillars.setMatrixAt(i, m4);
    });
    scene.add(pillars);

    /* ---------- stations (platforms + labels) ---------- */
    const platformMats: THREE.MeshLambertMaterial[] = [];
    const sprites: THREE.Sprite[] = [];
    stationMap.forEach(s => {
      const li = lineData.findIndex(ld => ld.cfg.id === [...s.lines][0]);
      const d = lines[li].geo.distanceOf(s.x, s.y);
      const y = elevAt(li, d);
      const ang = lines[li].geo.posAt(d).angle * Math.PI / 180;
      const ic = s.lines.size > 1;

      const w = ic ? 26 : 20, dep = ic ? 20 : 14;
      const mat = new THREE.MeshLambertMaterial({ color: DAY.platform });
      platformMats.push(mat);
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, 2.4, dep), mat);
      box.position.set(s.x, y - 1.6, s.y);
      box.rotation.y = -ang;
      scene.add(box);
      // Colored cap strips — one per serving line.
      const capColors = [...s.lines].map(lid => lineData.find(ld => ld.cfg.id === lid)!.cfg.color);
      capColors.forEach((c, i) => {
        const cap = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.92, 0.7, dep / capColors.length * 0.7),
          new THREE.MeshBasicMaterial({ color: c }),
        );
        const lane = (i - (capColors.length - 1) / 2) * (dep / capColors.length);
        cap.position.set(0, 1.6, lane);
        box.add(cap);
      });

      // Floating name label for named stations.
      if (!s.local || ic) {
        const cv = document.createElement('canvas');
        const scale = 2;
        cv.width = 512; cv.height = 96;
        const ctx = cv.getContext('2d')!;
        ctx.font = `600 ${26 * scale}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth = 9;
        ctx.strokeText(s.en, 256, 48);
        ctx.fillStyle = '#333a45';
        ctx.fillText(s.en, 256, 48);
        const tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = 4;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
        sp.scale.set(64, 12, 1);
        sp.position.set(s.x, y + 16, s.y);
        sp.renderOrder = 5;
        scene.add(sp);
        sprites.push(sp);
      }
    });

    /* ---------- trains ---------- */
    const coachGeo = new THREE.BoxGeometry(8, 4.6, 5.2);
    const headlightGeo = new THREE.ConeGeometry(3.2, 16, 12, 1, true);
    headlightGeo.rotateZ(Math.PI / 2); // point along +X
    headlightGeo.translate(12, 0, 0);
    const headlightMat = new THREE.MeshBasicMaterial({
      color: 0xfff3c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });

    interface TrainRt { group: THREE.Group; coaches: THREE.Mesh[]; light: THREE.Mesh }
    const bodyMats: { mat: THREE.MeshLambertMaterial; base: THREE.Color }[] = [];
    const trainPools: TrainRt[][][] = lines.map(L => {
      const mkTrain = (): TrainRt => {
        const group = new THREE.Group();
        group.visible = false;
        const coaches: THREE.Mesh[] = [];
        for (let ci = 0; ci < L.cfg.coaches; ci++) {
          const mat = new THREE.MeshLambertMaterial({ color: L.cfg.color, emissive: new THREE.Color(0xfff4d6), emissiveIntensity: 0 });
          bodyMats.push({ mat, base: new THREE.Color(L.cfg.color) });
          const c = new THREE.Mesh(coachGeo, mat);
          coaches.push(c);
          group.add(c);
        }
        const light = new THREE.Mesh(headlightGeo, headlightMat);
        coaches[0].add(light);
        scene.add(group);
        return { group, coaches, light };
      };
      return [0, 1].map(() => Array.from({ length: L.pool }, mkTrain));
    });

    /* ---------- theme ---------- */
    const applyTheme = (n: boolean) => {
      const T = n ? NIGHT : DAY;
      scene.background = new THREE.Color(T.bg);
      scene.fog = new THREE.Fog(T.bg, 1800, 6500);
      groundMat.color.set(T.ground);
      (grid.material as THREE.LineBasicMaterial).color.set(T.grid);
      hemi.intensity = T.hemi;
      sun.intensity = T.sun;
      pillarMat.color.set(T.pillar);
      platformMats.forEach(m => m.color.set(T.platform));
      trackMats.forEach(({ mat, base }) => mat.color.copy(base).multiplyScalar(T.trackMul));
      bodyMats.forEach(({ mat }) => { mat.emissiveIntensity = T.emissive; });
      headlightMat.opacity = n ? 0.22 : 0;
    };
    applyThemeRef.current = applyTheme;
    applyTheme(nightRef.current);

    resetViewRef.current = () => {
      camera.position.set(MAP_CX + 260, 1050, MAP_CY + 1150);
      controls.target.set(MAP_CX, 0, MAP_CY);
    };

    /* ---------- animation ---------- */
    let raf = 0;
    const euler = new THREE.Euler(0, 0, 0, 'YZX');
    const frame = () => {
      const now = Date.now() / 1000;
      const wallDate = new Date();

      lines.forEach((L, li) => {
        const headway = currentHeadway(L.cfg, wallDate);
        for (let dir = 0; dir < 2; dir++) {
          const slots = trainPools[li][dir];
          if (headway == null) { slots.forEach(t => { t.group.visible = false; }); continue; }
          const H = headway / COMPRESS;
          const phase = dir ? returnPhase(L.profile, H) : 0;
          const latest = Math.floor((now + BOARD_VIS - phase) / H);
          for (let k = 0; k < L.pool; k++) {
            const n = latest - k;
            const slot = ((n % L.pool) + L.pool) % L.pool;
            const t = slots[slot];
            const elapsed = now - (n * H + phase);
            const st = trainStateAt(L.profile, elapsed);
            // 3D has no per-object fade — trains pop at the fade midpoint.
            if (!st || st.opacity < 0.5) { t.group.visible = false; continue; }
            t.group.visible = true;
            const dist = dir ? L.geo.total - st.d : st.d;
            const off = TRACK_OFFSET * (1 - 2 * st.crossover);
            const trail = dir ? 1 : -1;
            for (let ci = 0; ci < t.coaches.length; ci++) {
              const cd = dist + trail * ci * COACH_SPACING;
              const p = L.geo.posAtExt(cd);
              const rad = p.angle * Math.PI / 180;
              const heading = dir ? rad + Math.PI : rad;
              const nx = Math.sin(heading), nz = -Math.cos(heading);
              const cdc = Math.max(0, Math.min(L.geo.total, cd));
              const y = elevAt(li, cdc) + 3.4;
              // Pitch from the elevation gradient so coaches ride the ramps.
              const dy = elevAt(li, Math.min(L.geo.total, cdc + 3)) - elevAt(li, Math.max(0, cdc - 3));
              const pitch = -Math.atan2(dy, 6) * (dir ? -1 : 1);
              const c = t.coaches[ci];
              c.position.set(p.x + nx * off, y, p.y + nz * off);
              euler.set(0, -heading, pitch);
              c.setRotationFromEuler(euler);
            }
          }
        }
      });

      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => {
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      renderer.dispose();
      sprites.forEach(sp => { sp.material.map?.dispose(); sp.material.dispose(); });
      scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      host.removeChild(renderer.domElement);
    };
  }, []);

  const h = svcNow ? istHour(svcNow) : null;
  const open = h != null && h >= SERVICE_START && h < SERVICE_END;

  return (
    <div className="metro3d-root">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap"
        rel="stylesheet"
      />
      <div ref={hostRef} className="metro3d-canvas" />

      <a className="m3d-pill m3d-back" href="/bangalore-metro">
        <ArrowLeft size={13} weight="bold" />
        2D map
      </a>

      <div className="m3d-title">
        <div className="m3d-name">Namma Metro — 3D</div>
        {h != null && (
          <div className="m3d-status">
            <span className={`svc-dot ${open ? 'on' : 'off'}`} />
            {open
              ? `In service · ${isPeak(h) ? 'peak' : 'off-peak'} frequency`
              : 'Service ended · resumes 05:00 IST'}
          </div>
        )}
      </div>

      <div className="twilight-overlay" style={{ opacity: twilight * 0.25 }} />

      <div className="m3d-toolbar">
        <button
          onClick={() => setThemeMode(night ? 'day' : 'night')}
          title={themeMode === 'auto' ? 'Theme follows the Bengaluru sky — click to override' : 'Toggle day/night'}
        >
          {night ? <Sun size={15} weight="bold" /> : <Moon size={15} weight="bold" />}
        </button>
        <button onClick={() => resetViewRef.current()} title="Reset view">
          <ArrowCounterClockwise size={15} weight="bold" />
        </button>
      </div>

      <div className="m3d-hint">Drag to orbit · scroll to zoom · right-drag to pan</div>
    </div>
  );
}

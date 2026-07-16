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
import Link from 'next/link';
import { ArrowCounterClockwise, ArrowLeft, Moon, Sun, X } from '@phosphor-icons/react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { lineData, buildStationMap, TUNNELS, MAP_CX, MAP_CY, type Point } from '@/metro/data';
import { buildGeometry, roundCorners, type Geometry } from '@/metro/geometry';
import { buildProfile, currentHeadway, poolSize, trainStateAt, returnPhase, turnaroundSlideDelay, BOARD_VIS, COMPRESS, istHour, SERVICE_START, SERVICE_END, isPeak, autoNight, twilightStrength, type Profile } from '@/metro/service';

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
  const exitRideRef = useRef<() => void>(() => {});
  const [riding, setRiding] = useState(false);
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

    /* ---------- viaduct deck (concrete girder + parapet + yellow edge line) ----------
       A strip is a triangle-ribbon swept along a line: ptsFn returns the two
       edge vertices per sample. Only built where the line is elevated. */
    const DECK_HALF = 6.5, PARAPET_H = 1.7, DECK_DROP = 1.2;
    const deckMat = new THREE.MeshLambertMaterial({ color: 0xd7d4cc, side: THREE.DoubleSide });
    const parapetMat = new THREE.MeshLambertMaterial({ color: 0xc4c1b8, side: THREE.DoubleSide });
    const yellowMat = new THREE.MeshBasicMaterial({ color: 0xf0c000, side: THREE.DoubleSide });
    const buildStrip = (
      li: number,
      ptsFn: (d: number, p: { x: number; y: number; angle: number }, nx: number, nz: number)
        => [[number, number, number], [number, number, number]],
      mat: THREE.Material,
    ) => {
      const geo = lines[li].geo;
      const positions: number[] = [];
      const indices: number[] = [];
      const step = 6;
      const n = Math.ceil(geo.total / step);
      let pair = 0;      // count of vertex-pairs pushed
      let prev = -1;     // pair index of the previous *contiguous* elevated sample
      for (let i = 0; i <= n; i++) {
        const d = Math.min(i * step, geo.total - 0.01);
        if (elevAt(li, d) < EL - 0.5) { prev = -1; continue; } // break the ribbon over tunnels
        const p = geo.posAt(d);
        const rad = p.angle * Math.PI / 180;
        const [a, b] = ptsFn(d, p, Math.sin(rad), -Math.cos(rad));
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        if (prev >= 0) {
          const k = prev * 2, c = pair * 2;
          indices.push(k, k + 1, c, k + 1, c + 1, c);
        }
        prev = pair;
        pair++;
      }
      if (pair < 2) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setIndex(indices);
      g.computeVertexNormals();
      scene.add(new THREE.Mesh(g, mat));
    };
    lines.forEach((_, li) => {
      const deckY = (d: number) => elevAt(li, d) - DECK_DROP;
      // deck surface
      buildStrip(li, (d, p, nx, nz) => [
        [p.x + nx * DECK_HALF, deckY(d), p.y + nz * DECK_HALF],
        [p.x - nx * DECK_HALF, deckY(d), p.y - nz * DECK_HALF],
      ], deckMat);
      // parapet walls (vertical) + yellow safety line, both edges
      for (const sgn of [1, -1]) {
        buildStrip(li, (d, p, nx, nz) => {
          const ex = p.x + nx * DECK_HALF * sgn, ez = p.y + nz * DECK_HALF * sgn;
          return [[ex, deckY(d), ez], [ex, deckY(d) + PARAPET_H, ez]];
        }, parapetMat);
        buildStrip(li, (d, p, nx, nz) => {
          const ex = p.x + nx * DECK_HALF * sgn, ez = p.y + nz * DECK_HALF * sgn;
          const ix = p.x + nx * (DECK_HALF - 0.7) * sgn, iz = p.y + nz * (DECK_HALF - 0.7) * sgn;
          const ty = deckY(d) + PARAPET_H;
          return [[ex, ty, ez], [ix, ty, iz]];
        }, yellowMat);
      }
    });

    /* ---------- stations (platforms + canopies + labels) ---------- */
    const platformMats: THREE.MeshLambertMaterial[] = [];
    const sprites: THREE.Sprite[] = [];
    // Unit barrel-vault (radius 1, length 1) — scaled per station. Arch springs
    // at local Y=0 and peaks at Y=1; axis runs along the track (local X).
    const canopyGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true, 0, Math.PI);
    canopyGeo.rotateZ(Math.PI / 2);
    const columnGeo = new THREE.CylinderGeometry(0.7, 0.7, 1, 8);
    const canopyMat = new THREE.MeshLambertMaterial({ color: 0x8fb4d6, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    const columnMat = new THREE.MeshLambertMaterial({ color: 0xb9bdc5 });
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

      // Elevated stations get a curved canopy on columns (skip underground).
      if (!s.underground) {
        const len = w * 1.05, rad = dep / 2 + 0.8, colH = 6.5;
        const grp = new THREE.Group();
        grp.position.set(s.x, 0, s.y);
        grp.rotation.y = -ang;
        const canopy = new THREE.Mesh(canopyGeo, canopyMat);
        canopy.scale.set(len, rad, rad);
        canopy.position.y = y + colH;
        grp.add(canopy);
        for (const cx of [-len / 2 + 2.5, len / 2 - 2.5]) {
          for (const cz of [-rad + 1.2, rad - 1.2]) {
            const col = new THREE.Mesh(columnGeo, columnMat);
            col.scale.y = colH;
            col.position.set(cx, y + colH / 2, cz);
            grp.add(col);
          }
        }
        scene.add(grp);
      }
    });

    /* ---------- trains ----------
       Each coach is a small group: body + curved-step roof with AC units,
       a dark window band (glows warm at night), an underframe skirt, and —
       on the lead car — a tapered nose, windshield and headlight beam. */
    const bodyGeo = new THREE.BoxGeometry(8, 3.0, 4.6);
    const roofGeo = new THREE.BoxGeometry(7.5, 0.8, 3.9);
    const stripeGeo = new THREE.BoxGeometry(8.04, 0.5, 4.66);   // belt-line livery stripe
    const acGeo = new THREE.BoxGeometry(2.0, 0.6, 1.7);
    const skirtGeo = new THREE.BoxGeometry(7.9, 0.9, 4.3);
    const windowGeo = new THREE.BoxGeometry(7.0, 1.05, 4.72);
    const bellowsGeo = new THREE.BoxGeometry(1.7, 2.4, 3.4);    // gangway between coaches
    const windshieldGeo = new THREE.BoxGeometry(0.5, 1.4, 3.4);
    const destGeo = new THREE.BoxGeometry(0.3, 0.5, 2.2);       // lit destination board
    const cornerGeo = new THREE.BoxGeometry(0.3, 0.5, 0.55);    // corner headlights
    // Tapered, bulbous nose — pinch the +X face of a short box inward.
    const noseGeo = new THREE.BoxGeometry(1.9, 3.0, 4.6);
    {
      const pos = noseGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getX(i) > 0.94) { pos.setY(i, pos.getY(i) * 0.62); pos.setZ(i, pos.getZ(i) * 0.55); }
      }
      pos.needsUpdate = true;
      noseGeo.computeVertexNormals();
    }
    const headlightGeo = new THREE.ConeGeometry(3.2, 16, 12, 1, true);
    headlightGeo.rotateZ(Math.PI / 2); // point along +X
    headlightGeo.translate(12, 0, 0);

    // Shared materials — stainless-steel livery (silver body, dark trim).
    const roofMat = new THREE.MeshLambertMaterial({ color: 0xaab0b8 });
    const acMat = new THREE.MeshLambertMaterial({ color: 0x3a4150 });
    const skirtMat = new THREE.MeshLambertMaterial({ color: 0x23272f });
    const bellowsMat = new THREE.MeshLambertMaterial({ color: 0x191d25 });
    const windshieldMat = new THREE.MeshLambertMaterial({ color: 0x0c1526 });
    const destMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
    const cornerMat = new THREE.MeshBasicMaterial({ color: 0xfff6e0 });
    const headlightMat = new THREE.MeshBasicMaterial({
      color: 0xfff3c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });

    interface TrainRt { group: THREE.Group; coaches: THREE.Object3D[]; light: THREE.Mesh }
    /** Every train group, for click-to-board raycasting (invisible ones are
        skipped automatically by intersectObjects). */
    const rideTargets: THREE.Object3D[] = [];
    const bodyMats: { mat: THREE.MeshLambertMaterial; base: THREE.Color }[] = [];
    const windowMats: THREE.MeshLambertMaterial[] = [];
    const cabMats: THREE.MeshLambertMaterial[] = [];
    const trainPools: TrainRt[][][] = lines.map(L => {
      // Line colour lives on the cab nose + belt-line stripe (faint glow at night
      // so the line stays identifiable). Registered for the theme toggle.
      const cabMat = new THREE.MeshLambertMaterial({ color: L.cfg.color, emissive: new THREE.Color(L.cfg.color), emissiveIntensity: 0 });
      cabMats.push(cabMat);
      const buildCoach = (ci: number, total: number): THREE.Group => {
        const lead = ci === 0;
        const c = new THREE.Group();
        const bodyMat = new THREE.MeshLambertMaterial({ color: 0xc9cdd3, emissive: new THREE.Color(0xfff4d6), emissiveIntensity: 0 });
        bodyMats.push({ mat: bodyMat, base: new THREE.Color(0xc9cdd3) });
        c.add(new THREE.Mesh(bodyGeo, bodyMat));
        const roof = new THREE.Mesh(roofGeo, roofMat); roof.position.y = 1.55; c.add(roof);
        [-1.1, 2.1].forEach(x => { const ac = new THREE.Mesh(acGeo, acMat); ac.position.set(x, 2.15, 0); c.add(ac); });
        const skirt = new THREE.Mesh(skirtGeo, skirtMat); skirt.position.y = -1.6; c.add(skirt);
        const stripe = new THREE.Mesh(stripeGeo, cabMat); stripe.position.y = -0.35; c.add(stripe);
        const winMat = new THREE.MeshLambertMaterial({ color: 0x0e1626, emissive: new THREE.Color(0xfff4d6), emissiveIntensity: 0 });
        windowMats.push(winMat);
        const win = new THREE.Mesh(windowGeo, winMat); win.position.y = 0.42; c.add(win);
        // gangway bellows reaching toward the following coach
        if (ci < total - 1) {
          const bel = new THREE.Mesh(bellowsGeo, bellowsMat); bel.position.set(-4.85, -0.1, 0); c.add(bel);
        }
        if (lead) {
          const nose = new THREE.Mesh(noseGeo, cabMat); nose.position.x = 4.1; c.add(nose);
          const wind = new THREE.Mesh(windshieldGeo, windshieldMat); wind.position.set(4.35, 0.55, 0); c.add(wind);
          const dest = new THREE.Mesh(destGeo, destMat); dest.position.set(4.55, 1.15, 0); c.add(dest);
          [-1.55, 1.55].forEach(z => { const hl = new THREE.Mesh(cornerGeo, cornerMat); hl.position.set(4.78, -0.7, z); c.add(hl); });
        }
        return c;
      };
      const mkTrain = (): TrainRt => {
        const group = new THREE.Group();
        group.visible = false;
        const coaches: THREE.Object3D[] = [];
        for (let ci = 0; ci < L.cfg.coaches; ci++) {
          const c = buildCoach(ci, L.cfg.coaches);
          coaches.push(c);
          group.add(c);
        }
        const light = new THREE.Mesh(headlightGeo, headlightMat);
        coaches[0].add(light);
        scene.add(group);
        const rt: TrainRt = { group, coaches, light };
        group.userData.rt = rt;   // walked up to from a raycast hit
        rideTargets.push(group);
        return rt;
      };
      return [0, 1].map(() => Array.from({ length: L.pool }, mkTrain));
    });

    /* ---------- ride the cab ----------
       Click a train to ride in its front cab; the camera locks to the lead
       coach and looks down the line, so it travels the whole route on the
       schedule — through curves, up/down the tunnel ramps, dwelling at
       stations. Esc or the Exit button hands control back to the orbit cam. */
    let ridden: TrainRt | null = null;
    const lastRidePos = new THREE.Vector3(MAP_CX, EL, MAP_CY);
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const boardTrain = (rt: TrainRt) => {
      ridden = rt;
      controls.enabled = false;
      camera.fov = 72; camera.updateProjectionMatrix();
      setRiding(true);
    };
    const exitRide = () => {
      if (!ridden) return;
      ridden = null;
      camera.fov = 50; camera.updateProjectionMatrix();
      // resume the orbit cam framed on where the ride left off
      controls.target.copy(lastRidePos);
      camera.position.set(lastRidePos.x + 160, lastRidePos.y + 130, lastRidePos.z + 160);
      controls.enabled = true;
      setRiding(false);
    };
    exitRideRef.current = exitRide;

    let downX = 0, downY = 0;
    const onDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; };
    const onClick = (e: MouseEvent) => {
      // ignore orbit drags — only a genuine click boards
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(rideTargets, true);
      if (!hits.length) return;
      let o: THREE.Object3D | null = hits[0].object;
      while (o && !o.userData.rt) o = o.parent;
      if (o && o.userData.rt) boardTrain(o.userData.rt as TrainRt);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitRide(); };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);

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
      bodyMats.forEach(({ mat }) => { mat.emissiveIntensity = n ? 0.06 : 0; });
      windowMats.forEach(m => { m.emissiveIntensity = n ? 0.95 : 0; });
      cabMats.forEach(m => { m.emissiveIntensity = n ? 0.4 : 0; });
      headlightMat.opacity = n ? 0.22 : 0;
    };
    applyThemeRef.current = applyTheme;
    applyTheme(nightRef.current);

    resetViewRef.current = () => {
      exitRide();
      camera.position.set(MAP_CX + 260, 1050, MAP_CY + 1150);
      controls.target.set(MAP_CX, 0, MAP_CY);
    };

    /* ---------- animation ---------- */
    let raf = 0;
    const euler = new THREE.Euler(0, 0, 0, 'YZX');
    const tmpV = new THREE.Vector3();
    const frame = () => {
      const now = Date.now() / 1000;
      const wallDate = new Date();
      // Lead-coach pose of the ridden train, captured while it is positioned.
      let rideCap: { li: number; x: number; y: number; z: number; heading: number; cd: number; dir: number } | null = null;

      lines.forEach((L, li) => {
        const headway = currentHeadway(L.cfg, wallDate);
        const H = headway != null ? headway / COMPRESS : 1;
        const phases: [number, number] = [0, headway != null ? returnPhase(L.profile, H) : 0];
        for (let dir = 0; dir < 2; dir++) {
          const slots = trainPools[li][dir];
          if (headway == null) { slots.forEach(t => { t.group.visible = false; }); continue; }
          const phase = phases[dir];
          const latest = Math.floor((now + BOARD_VIS - phase) / H);
          for (let k = 0; k < L.pool; k++) {
            const n = latest - k;
            const slot = ((n % L.pool) + L.pool) % L.pool;
            const t = slots[slot];
            const elapsed = now - (n * H + phase);
            const slideDelay = turnaroundSlideDelay(L.profile, H, phase, phases[1 - dir], n);
            const st = trainStateAt(L.profile, elapsed, slideDelay);
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
              if (ridden && t === ridden && ci === 0) {
                rideCap = { li, x: p.x + nx * off, y, z: p.y + nz * off, heading, cd, dir };
              }
            }
          }
        }
      });

      if (ridden) {
        if (rideCap) {
          const { li, x, y, z, heading, cd, dir } = rideCap;
          const geo = lines[li].geo;
          // Perch just above and ahead of the lead cab, looking down the line —
          // a driver's-eye view with only a sliver of the nose in frame.
          const fx = Math.cos(heading), fz = Math.sin(heading);
          const desired = tmpV.set(x + fx * 5.6, y + 2.1, z + fz * 5.6);
          camera.position.lerp(desired, 0.5);
          lastRidePos.copy(desired);
          // look down the track ahead — follows curves and tunnel ramps
          const ahead = cd + (dir ? -1 : 1) * 70;
          const ap = geo.posAtExt(ahead);
          const ah = ap.angle * Math.PI / 180 + (dir ? Math.PI : 0);
          const anx = Math.sin(ah), anz = -Math.cos(ah);
          const ty = elevAt(li, Math.max(0, Math.min(geo.total, ahead))) + 3.4 + 1.4;
          camera.lookAt(ap.x + anx * TRACK_OFFSET, ty, ap.y + anz * TRACK_OFFSET);
        } else {
          // the ridden train finished its run (faded out) — hand back to orbit
          exitRide();
          controls.update();
        }
      } else {
        controls.update();
      }
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
      window.removeEventListener('keydown', onKey);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('click', onClick);
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

      <Link className="m3d-pill m3d-back" href="/">
        <ArrowLeft size={13} weight="bold" />
        2D map
      </Link>

      {riding && (
        <button className="m3d-pill m3d-exit" onClick={() => exitRideRef.current()}>
          <X size={13} weight="bold" />
          Exit ride
        </button>
      )}

      <div className="m3d-title">
        <div className="m3d-name">{riding ? 'Namma Metro — cab view' : 'Namma Metro — 3D'}</div>
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

      <div className="m3d-hint">
        {riding
          ? 'Riding the cab · Esc or Exit to leave'
          : 'Click a train to ride · drag to orbit · scroll to zoom'}
      </div>
    </div>
  );
}

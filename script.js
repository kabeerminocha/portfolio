// Smooth scrolling for navigation links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// --- Scroll effects (nav transparency + fade-ins + spider drone) ---

const nav = document.querySelector('nav');
const character = document.querySelector('.character');
const dottedPath = document.querySelector('.dotted-path');

// Cached layout metrics
let charStart = 0;
let charRange = 1;
let charEnabled = false;
let pathLeft = 0;
let charWidth = 52;

function measureCharacterRange() {
    const contactSection = document.querySelector('#contact');
    if (!nav || !contactSection || !character) {
        charEnabled = false;
        if (character) character.style.display = 'none';
        return;
    }
    charStart = nav.offsetTop + nav.offsetHeight + 20;
    const end = contactSection.offsetTop + contactSection.offsetHeight + 20;
    charRange = Math.max(end - charStart, 1);

    if (dottedPath) pathLeft = dottedPath.getBoundingClientRect().left;
    charWidth = parseFloat(getComputedStyle(character).width) || 52;
    charEnabled = true;
}

// The vine's centerline (quadratic segments, in the vine SVG's 60x1000
// viewBox) and width profile — kept in sync with the generated trunk shape
// so the drone can center itself on the trunk and grip its actual width.
const VINE_SEGS = [
    [[30, 0], [40, 83.3], [35, 166.7]],
    [[35, 166.7], [20, 250], [25, 333.3]],
    [[25, 333.3], [40, 416.7], [35, 500]],
    [[35, 500], [20, 583.3], [25, 666.7]],
    [[25, 666.7], [40, 750], [35, 833.3]],
    [[35, 833.3], [20, 916.7], [25, 1000]],
];

function vineAt(yU) {
    const segLen = 1000 / 6;
    const i = Math.min(Math.max(Math.floor(yU / segLen), 0), 5);
    const t = Math.min(Math.max((yU - i * segLen) / segLen, 0), 1);
    const [p0, p1, p2] = VINE_SEGS[i];
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const dx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
    const dy = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
    let w = 19.0 + 7.0 * (yU / 1000) + 1.8 * Math.sin(yU / 71) + 1.0 * Math.sin(yU / 29 + 2);
    w = Math.max(w, 17);
    return { x, dx, dy, w };
}

/* ====================================================================
   Spider drone IK gait engine.

   Modeled on real spider locomotion: an alternating-tetrapod gait
   ({L1,L3,R2,R4} vs {L2,L4,R1,R3}) with a duty factor around 2/3 —
   feet spend most of the cycle GRIPPING a fixed point on the trunk
   while the body moves past them (2-bone IK bends each leg to keep its
   planted claw glued in place: that is the pull). When a leg
   overstretches it releases, swings quickly ahead in the direction of
   travel (folding as it reaches — stride lengthens with speed), and
   re-grips. One tetrapod always supports while the other steps. The
   body itself is a damped spring chasing the scroll position, so it
   lags, surges, and settles with weight.
   ==================================================================== */

const FEMUR = 14;
const TIBIA = 15;

const LEG_DEFS = [
    { id: 'l1', hip: [43, 37], rest: -19, side: -1, group: 0 },
    { id: 'l2', hip: [41, 45], rest: -13, side: -1, group: 1 },
    { id: 'l3', hip: [41, 55], rest: 13,  side: -1, group: 0 },
    { id: 'l4', hip: [43, 63], rest: 19,  side: -1, group: 1 },
    { id: 'r1', hip: [57, 37], rest: -19, side: 1,  group: 1 },
    { id: 'r2', hip: [59, 45], rest: -13, side: 1,  group: 0 },
    { id: 'r3', hip: [59, 55], rest: 13,  side: 1,  group: 1 },
    { id: 'r4', hip: [57, 63], rest: 19,  side: 1,  group: 0 },
];

const legs = [];
if (character) {
    LEG_DEFS.forEach((def, i) => {
        const el = character.querySelector(`[data-leg="${def.id}"]`);
        if (!el) return;
        legs.push({
            ...def,
            els: {
                femur: el.querySelector('.femur'),
                piston: el.querySelector('.piston'),
                tibia: el.querySelector('.tibia-seg'),
                claw: el.querySelector('.claw'),
                kneePin: el.querySelector('.knee-pin'),
                footPin: el.querySelector('.foot-pin'),
            },
            footX: 50 + def.side * 15, // svg units
            footYPx: 0,                // viewport px (world anchor)
            renderedYPx: 0,            // last drawn world y (for re-anchoring)
            swing: null,
            plantedAt: 0,              // refractory: no immediate re-step
            // rhythmic-gait phase offset: tetrapods half a cycle apart,
            // small in-group stagger so it never looks metronomic
            oscOff: (def.group === 0 ? 0 : 0.5) + (i % 4) * 0.045,
            // per-leg variation so steps never fire in lockstep
            trigger: 8.5 * (0.9 + 0.25 * ((i * 37) % 10) / 10),
            swingDur: 210 + ((i * 53) % 5) * 16,
        });
    });
}

let targetTop = 0;       // where the scroll wants the body
let springTop = 0;       // where the body actually is (damped spring)
let currentVine = vineAt(100);
let travelDir = 1;
let bodyVel = 0;         // body speed, px/s (smoothed)
let gaitPhase = 0;       // rhythmic gait cycle position (in cycles)
let oscBlend = 0;        // 0 = anchored discrete steps, 1 = rhythmic gait
let oscBlendPrev = 0;
let lastActivity = 0;
let loopRunning = false;
let lastTick = 0;
let lastFrameAt = 0;   // when a frame ACTUALLY ran (not just was requested)
let loopStartedAt = 0;
let walkTimer = null;
let lastScrollTop = 0;
let smoothedSpeed = 0;

function bodyCenterY() {
    return springTop + charWidth / 2;
}

// where a claw should grab: right at the trunk's edge at its current width,
// so the whole leg stays on the bark (the claw curls over the edge)
function gripX(leg) {
    const halfU = (currentVine.w / 2) * (100 / charWidth);
    const offset = Math.min(Math.max(halfU + 1, 12), 25);
    return 50 + leg.side * offset;
}

function ikKnee(hip, fx, fy, side) {
    let dx = fx - hip[0];
    let dy = fy - hip[1];
    let D = Math.hypot(dx, dy);
    const maxD = FEMUR + TIBIA - 0.6;
    const minD = TIBIA - FEMUR + 0.8;
    if (D > maxD) {
        // overstretched: keep the leg SPLAYED — preserve its lateral reach
        // and let the foot slip along the trunk axis instead of folding
        // in toward the body (spiders don't tuck their legs under)
        if (Math.abs(dx) < maxD - 1) {
            dy = Math.sign(dy || 1) * Math.sqrt(maxD * maxD - dx * dx);
        } else {
            const s = maxD / D; dx *= s; dy *= s;
        }
        D = Math.hypot(dx, dy);
    }
    if (D < minD) { const s = minD / (D || 1); dx *= s; dy *= s; D = minD; }
    const a = Math.atan2(dy, dx);
    const cosA1 = (FEMUR * FEMUR + D * D - TIBIA * TIBIA) / (2 * FEMUR * D);
    const a1 = Math.acos(Math.min(1, Math.max(-1, cosA1)));
    const k1x = hip[0] + FEMUR * Math.cos(a - a1);
    const k1y = hip[1] + FEMUR * Math.sin(a - a1);
    const k2x = hip[0] + FEMUR * Math.cos(a + a1);
    const k2y = hip[1] + FEMUR * Math.sin(a + a1);
    // knee bows outward, away from the body
    if (side < 0) return k1x < k2x ? [k1x, k1y, hip[0] + dx, hip[1] + dy] : [k2x, k2y, hip[0] + dx, hip[1] + dy];
    return k1x > k2x ? [k1x, k1y, hip[0] + dx, hip[1] + dy] : [k2x, k2y, hip[0] + dx, hip[1] + dy];
}

function renderLeg(leg, now) {
    const u = 100 / charWidth;   // svg units per px
    const bodyCY = bodyCenterY();
    let fx, fy, swinging = false;

    if (leg.swing) {
        const s = leg.swing;
        let p = (now - s.t0) / s.dur;
        if (p >= 1) {
            leg.footX = s.toX;
            leg.footYPx = s.toYPx;
            leg.swing = null;
            leg.plantedAt = now;
            fx = leg.footX;
            fy = 50 + (leg.footYPx - bodyCY) * u;
        } else {
            swinging = true;
            const e = p * p * (3 - 2 * p); // smoothstep
            fx = s.fromX + (s.toX - s.fromX) * e;
            const yPx = s.fromYPx + (s.toYPx - s.fromYPx) * e;
            fy = 50 + (yPx - bodyCY) * u;
            // mid-swing the foot arcs OUTWARD (staying splayed, like a real
            // spider stepping around the branch) with only a slight lift
            const arc = Math.sin(Math.PI * p);
            fx += leg.side * arc * 3;
            const hx = leg.hip[0], hy = leg.hip[1];
            const vx = hx - fx, vy = hy - fy;
            const L = Math.hypot(vx, vy) || 1;
            fx += (vx / L) * arc * 1.5;
            fy += (vy / L) * arc * 1.5;
        }
    } else {
        fx = leg.footX;
        fy = 50 + (leg.footYPx - bodyCY) * u;
    }

    // Above walking pace, blend from world-anchored feet into a rhythmic
    // stance/swing oscillation whose cadence tracks body speed — every leg
    // strokes around its rest pose in tetrapod phase, so none is ever
    // dragged out behind the body.
    if (oscBlend > 0.01) {
        const ph = (gaitPhase + leg.oscOff) * 2 * Math.PI;
        // stroke amplitude fades as speed dies, so legs converge gently to
        // their rest grip instead of freezing mid-stride
        const amp = Math.min(9, 4 + Math.abs(bodyVel) * 0.03) * (0.25 + 0.75 * oscBlend);
        const oscY = leg.hip[1] + leg.rest - Math.cos(ph) * amp * travelDir;
        const oscX = gripX(leg);
        fx = fx * (1 - oscBlend) + oscX * oscBlend;
        fy = fy * (1 - oscBlend) + oscY * oscBlend;
        const swingHalf = Math.sin(ph) > 0; // foot recovering forward
        if (oscBlend > 0.5) {
            swinging = swingHalf;
            if (swingHalf) fx += leg.side * Math.sin(ph) * 2.5; // outward step-around
        }
    }
    // curvature correction: the body's lean already follows the trunk's
    // tangent, but on bends the centerline curves away from that line.
    // Shift each foot by the trunk's residual offset at ITS height, so
    // every leg sits on the bark at its own position along the curve.
    if (vhCache > 1) {
        const dyPx = (fy - 50) * (charWidth / 100);
        const yUf = bodyYU + dyPx * (1000 / vhCache);
        const residualPx = (vineAt(yUf).x - currentVine.x) - trunkSlope * dyPx;
        fx += residualPx * u;
    }

    leg.renderedYPx = bodyCY + (fy - 50) / u;

    const [kx, ky, cfx, cfy] = ikKnee(leg.hip, fx, fy, leg.side);
    const hx = leg.hip[0], hy = leg.hip[1];

    leg.els.femur.setAttribute('d', `M${hx},${hy} L${kx.toFixed(1)},${ky.toFixed(1)}`);
    // piston rides parallel to the femur
    const vx = kx - hx, vy = ky - hy;
    const L = Math.hypot(vx, vy) || 1;
    const px = -vy / L * 1.4 * leg.side, py = vx / L * 1.4 * leg.side;
    leg.els.piston.setAttribute('d',
        `M${(hx + vx * 0.25 + px).toFixed(1)},${(hy + vy * 0.25 + py).toFixed(1)} L${(hx + vx * 0.72 + px).toFixed(1)},${(hy + vy * 0.72 + py).toFixed(1)}`);
    leg.els.tibia.setAttribute('d', `M${kx.toFixed(1)},${ky.toFixed(1)} L${cfx.toFixed(1)},${cfy.toFixed(1)}`);
    const cs = cfx < 50 ? 1 : -1;
    leg.els.claw.setAttribute('d', `M${cfx.toFixed(1)},${cfy.toFixed(1)} q${cs * 2},1.5 ${cs * 5},0.8`);
    leg.els.claw.style.opacity = swinging ? 0.25 : 0.85; // claw opens in the air
    leg.els.kneePin.setAttribute('cx', kx.toFixed(1));
    leg.els.kneePin.setAttribute('cy', ky.toFixed(1));
    leg.els.footPin.setAttribute('cx', cfx.toFixed(1));
    leg.els.footPin.setAttribute('cy', cfy.toFixed(1));
}

function otherGroupSwinging(group) {
    return legs.some(l => l.swing && l.group !== group);
}

function startSwing(leg, lead, now) {
    const u = charWidth / 100; // px per svg unit
    const hustling = Math.abs(targetTop - springTop) > 60;
    leg.swing = {
        t0: now,
        dur: hustling ? leg.swingDur * 0.72 : leg.swingDur,
        fromX: leg.footX,
        fromYPx: leg.footYPx,
        toX: gripX(leg),
        toYPx: bodyCenterY() + (leg.hip[1] + leg.rest + lead - 50) * u,
    };
}

function updateGait(now, moving) {
    // at speed the rhythmic oscillator owns the legs — no discrete steps
    if (oscBlend > 0.1) return;
    const u = 100 / charWidth;
    const bodyCY = bodyCenterY();
    // hustle mode: when the body is well behind its target it keeps a
    // brisker cadence — shorter grip pauses, longer reaching strides
    const hustling = Math.abs(targetTop - springTop) > 60;
    // stride lengthens with speed, like a real spider
    const lead = moving ? travelDir * (5 + Math.min(9, smoothedSpeed * 0.05) + (hustling ? 3 : 0)) : 0;
    const refractory = hustling ? 140 : 240;

    for (const leg of legs) {
        if (leg.swing) continue;
        // refractory period after planting: a real leg grips before it can
        // step again (keeps duty factor high and stops frantic re-stepping)
        if (now - leg.plantedAt < refractory) continue;
        const fyU = 50 + (leg.footYPx - bodyCY) * u;
        const stretch = fyU - (leg.hip[1] + leg.rest);
        // a leg left behind by the direction of travel steps sooner — it
        // reaches ahead instead of ever being dragged along
        const lagging = moving && Math.sign(stretch) !== Math.sign(travelDir);
        const threshold = !moving ? 5 : (lagging ? leg.trigger * 0.6 : leg.trigger * 1.3);
        if (Math.abs(stretch) > threshold && !otherGroupSwinging(leg.group)) {
            startSwing(leg, lead, now);
        }
    }
}

function plantAllFeet() {
    const u = charWidth / 100;
    const bodyCY = bodyCenterY();
    const now = performance.now();
    for (const leg of legs) {
        leg.swing = null;
        leg.footX = gripX(leg);
        leg.footYPx = bodyCY + (leg.hip[1] + leg.rest - 50) * u;
        renderLeg(leg, now);
    }
}

let bodyYU = 100;        // trunk parameter at the body's position
let vhCache = 0;
let trunkSlope = 0;      // trunk dx/dy at the body, in screen px/px

function layoutBody() {
    const viewportHeight = window.innerHeight;
    if (viewportHeight < 2) return; // degenerate viewport: keep last position
    const percent = Math.min(Math.max((springTop / viewportHeight - 0.10) / 0.80, 0), 1);
    bodyYU = 100 + 800 * percent;
    vhCache = viewportHeight;
    currentVine = vineAt(bodyYU);
    trunkSlope = currentVine.dx / (currentVine.dy * viewportHeight / 1000);

    character.style.display = 'block';
    character.style.top = `${springTop.toFixed(2)}px`;
    character.style.right = 'auto';
    character.style.left = `${(pathLeft + currentVine.x - charWidth / 2).toFixed(2)}px`;

    const angle = -Math.atan2(currentVine.dx, currentVine.dy * viewportHeight / 1000) * 180 / Math.PI;
    character.style.transform = `rotate(${angle.toFixed(2)}deg)`;
}

// Direct positioning: used at init, on resume, and whenever we must place
// the drone without animating (it can never be stranded off its trunk).
function snapSpider() {
    springTop = targetTop;
    bodyVel = 0;
    oscBlend = 0;
    oscBlendPrev = 0;
    layoutBody();
    plantAllFeet();
}

// React to the scroll position having changed (detected by polling — scroll
// events never fire in some embedded surfaces, so we don't rely on them).
function handleScrollChange(scrollTop) {
    updateFadeIns();
    updateNav(scrollTop);

    if (!charEnabled) return;
    const viewportHeight = window.innerHeight;
    if (viewportHeight < 2) return; // degenerate viewport: don't corrupt state

    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;

    let scrollPercent = (scrollTop - charStart) / charRange;
    scrollPercent = Math.min(Math.max(scrollPercent, 0), 1);
    targetTop = viewportHeight * 0.10 + scrollPercent * viewportHeight * 0.80;

    lastActivity = performance.now();
    smoothedSpeed = 0.7 * smoothedSpeed + 0.3 * Math.abs(delta);
    // chassis sway cadence follows speed
    const gait = Math.min(1.2, Math.max(0.55, 45 / Math.max(smoothedSpeed, 1)));
    character.style.setProperty('--gait', `${gait.toFixed(2)}s`);
    character.classList.add('walking');
    clearTimeout(walkTimer);
    walkTimer = setTimeout(() => character.classList.remove('walking'), 300);
}

// One permanent frame loop drives everything: it polls the scroll position
// and runs the body spring + IK gait whenever there is work to do. When
// fully settled it costs one scrollY read per frame.
function frame(now) {
    try {
        const scrollTop = window.scrollY;
        if (Math.abs(scrollTop - lastScrollTop) > 0.5) {
            handleScrollChange(scrollTop);
        }

        if (charEnabled) {
            const dt = Math.min((now - lastTick) / 1000, 0.05);
            lastTick = now;

            // never let the drone fall more than ~40% of a screen behind —
            // beyond that it "was already there" and crawls the last stretch
            const maxLag = window.innerHeight * 0.4;
            if (Math.abs(targetTop - springTop) > maxLag) {
                springTop = targetTop - Math.sign(targetTop - springTop) * maxLag;
            }

            const gap = targetTop - springTop;
            const anySwing = legs.some(l => l.swing);
            if (Math.abs(gap) > 0.3 || anySwing || (now - lastActivity) < 600) {
                // damped spring toward the target, but with a hard speed cap:
                // the body only ever moves at a pace its legs can plausibly
                // climb, so fast scrolling reads as hurried crawling — the
                // drone glides the rest of the way after you stop
                let step = gap * (1 - Math.exp(-dt * 8));
                const maxStep = 170 * dt; // crawl speed cap, px/s
                if (Math.abs(step) > maxStep) step = Math.sign(step) * maxStep;
                springTop += step;
                if (Math.abs(gap) > 0.5) travelDir = gap > 0 ? 1 : -1;

                // body speed drives the gait: cadence locks to velocity, and
                // above walking pace the legs shift from anchored gripping
                // to rhythmic stroking (blended smoothly both ways)
                const instVel = dt > 0 ? step / dt : 0;
                bodyVel = 0.8 * bodyVel + 0.2 * instVel;
                gaitPhase += Math.min(Math.abs(bodyVel), 200) * dt / 46; // ~1 cycle per 46px
                // the gap is an instant speed proxy: a hard scroll flick
                // engages the rhythmic gait immediately, before the smoothed
                // velocity has caught up — no stretched-leg transient
                const speedProxy = Math.max(Math.abs(bodyVel), Math.abs(gap) * 1.5);
                oscBlend = Math.min(Math.max((speedProxy - 12) / 28, 0), 1);

                // while the oscillator owns the legs, feet continuously track
                // their drawn positions — so no anchor can ever go stale, and
                // when speed dies the anchored grip resumes exactly where the
                // legs already are (no jump, no flung-back freeze)
                if (oscBlend > 0.1) {
                    for (const leg of legs) {
                        leg.footYPx = leg.renderedYPx || leg.footYPx;
                        leg.footX = gripX(leg);
                        if (leg.swing) leg.swing = null;
                    }
                }
                if (oscBlendPrev > 0.1 && oscBlend <= 0.1) {
                    // just came off the rhythm: hold the grip for a beat
                    // before any settle-steps
                    for (const leg of legs) leg.plantedAt = now;
                }
                oscBlendPrev = oscBlend;

                layoutBody();
                const moving = Math.abs(gap) > 0.5 || (now - lastActivity) < 150;
                updateGait(now, moving);
                for (const leg of legs) renderLeg(leg, now);
            }
        }
    } catch (e) {
        // never let an error kill the loop
    }
    requestAnimationFrame(frame);
}

function updateNav(scrollTop) {
    nav.classList.toggle('scrolled', scrollTop > 100);
}

// Fade sections in as they enter the viewport. Elements are dropped from the
// list once revealed, so this becomes free after everything has appeared.
let pendingFadeIns = Array.from(document.querySelectorAll('.fade-in'));

function updateFadeIns() {
    if (pendingFadeIns.length === 0) return;
    const threshold = window.innerHeight - 50;
    pendingFadeIns = pendingFadeIns.filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.top < threshold && rect.bottom > 0) {
            el.classList.add('visible');
            return false;
        }
        return true;
    });
}

function initSpider() {
    measureCharacterRange();
    if (!charEnabled) return;
    let scrollPercent = (window.scrollY - charStart) / charRange;
    scrollPercent = Math.min(Math.max(scrollPercent, 0), 1);
    targetTop = window.innerHeight * 0.10 + scrollPercent * window.innerHeight * 0.80;
    lastScrollTop = window.scrollY;
    snapSpider();
}

initSpider();
updateFadeIns();
updateNav(window.scrollY);
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && charEnabled) {
        handleScrollChange(window.scrollY);
        snapSpider();
    }
});
window.addEventListener('resize', () => {
    measureCharacterRange();
    snapSpider();
});
// Re-measure once everything (including images) has loaded, since section
// offsets can shift as content arrives.
window.addEventListener('load', () => {
    measureCharacterRange();
    snapSpider();
});

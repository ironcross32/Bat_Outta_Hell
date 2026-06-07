        // ===== Power-up system =====
        // Shield / Rocket / Horn ball pickups. LIFO inventory (max 3), SHIFT activates
        // (newest first), only one active at a time. Pickups spawn on an independent
        // 2–4s roll whose probability ramps with monotonic score peak and accumulated
        // high-speed time. See plan-out-a-power-up-cozy-tide.md.
        const POWERUP_TYPES = ['shield', 'rocket', 'hornBall'];
        const POWERUP_PRETTY = { shield: 'Shield', rocket: 'Rocket', hornBall: 'Horn ball' };
        const POWERUP_MAX_QUEUE = 3;
        const POWERUP_GAIN_MIN_DB = -16;
        const POWERUP_GAIN_MAX_DB = 2;
        const POWERUP_DESPAWN_AT = -50;
        const POWERUP_BASE_CHANCE = 0.38;
        const POWERUP_SCORE_STEP = 500;
        const POWERUP_SCORE_NUDGE = 0.05;
        const POWERUP_SPEED_STEP = 30;
        const POWERUP_SPEED_NUDGE = 0.02;
        const POWERUP_HIGH_SPEED_MPH = 60;
        const POWERUP_MAX_CHANCE = 0.85;

        const ROCKET_DURATION = 20;
        const ROCKET_TARGET_SPEED = 150;
        const ROCKET_GASCAN_EXTEND = 5;
        const ROCKET_STACK_EXTEND = 15;   // seconds added when a rocket is collected while one is active
        const ROCKET_BOOST_SPEED = 175;   // temporary speed cap for the stack burst
        const ROCKET_BOOST_DURATION = 3;  // seconds the burst lasts
        const HORNBALL_DURATION = 60;
        const PROJECTILE_LIFETIME = 30;
        const PROJECTILE_MAX_DISTANCE = 150;
        const PROJECTILE_HIT_RADIUS = 12;
        // Self-damage blast zone when a fired horn-ball detonates a gas can.
        // Distance units (90 = 1 s at 100 mph); damage falls off linearly to 0
        // at the edge. Kept generous so shooting a can near your bumper hurts
        // without demanding pixel-perfect proximity.
        const GASCAN_BLAST_RADIUS = 35;
        const GASCAN_BLAST_DAMAGE = 40;
        const COIN_VALUE_MIN = 50;
        const COIN_VALUE_MAX = 200;
        const COIN_GAP_MIN = 2;
        const COIN_GAP_MAX = 4;
        const STREAK_FIRST_WINDOW = 8;
        const STREAK_EXTEND = 5;
        // Cap on remaining streak window: each extension is clamped so the streak
        // can never live more than STREAK_MAX_WINDOW seconds without another hit.
        const STREAK_MAX_WINDOW = 15;
        const STREAK_BASE_HZ = 196;          // G3
        const STREAK_QUARTER_TONE = Math.pow(2, 1 / 24);

        // Blues major scale (semitone offsets per octave: root, M2, m3, M3, P5, M6).
        // coinCollectHz() maps streak count → frequency from A3 up to A8 (7040 Hz).
        const COIN_COLLECT_SCALE_ROOT_HZ = 440; // A4
        const COIN_COLLECT_MAX_HZ = 7040;       // A8
        const BLUES_MAJOR_SEMITONES = [0, 2, 3, 4, 7, 9];
        function coinCollectHz(streakCount) {
            const octave = Math.floor(streakCount / 6);
            const degree = BLUES_MAJOR_SEMITONES[streakCount % 6];
            const hz = COIN_COLLECT_SCALE_ROOT_HZ * Math.pow(2, (octave * 12 + degree) / 12);
            return Math.min(hz, COIN_COLLECT_MAX_HZ);
        }

        let powerUpScoreCeiling = 0;
        let highSpeedSeconds = 0;
        const powerUpQueue = [];
        let activePowerUp = null;

        const powerUpPickup = {
            type: null, lane: 1, distance: 100, active: false, consumed: false,
            prop: null, nextCycleAt: 0,
        };

        let shieldCount = 0;

        let rocketWind = null;
        let rocketPrevTargetSpeed = 0;
        let rocketBoostActive = false;
        let rocketBoostExpiresAt = 0;
        // Accumulated active-rocket time for the current run (reset on each
        // activation). Drives the points payout at run end and the rising
        // chance that rocket pickups get swapped for obstacles mid-run.
        let rocketRunSeconds = 0;
        const ROCKET_END_POINTS_PER_MIN = 300;
        const ROCKET_CONVERT_STEP = 0.02;  // +2% per full minute of rocket time
        const ROCKET_CONVERT_CAP = 0.12;   // capped at 12%

        // Chance a rocket pickup is converted into an obstacle while a rocket
        // run is in progress — zero outside a run, climbing 2% per elapsed
        // minute of rocket time up to 12%.
        function rocketConversionChance() {
            if (!activePowerUp || activePowerUp.type !== 'rocket') return 0;
            return Math.min(ROCKET_CONVERT_CAP, ROCKET_CONVERT_STEP * Math.floor(rocketRunSeconds / 60));
        }

        const coin = {
            lane: 1, distance: 100, active: false, consumed: false,
            prop: null, nextCycleAt: 0, nextSpawnAt: 0,
        };

        const projectile = {
            active: false, lane: 1, distance: 0, age: 0, expiresAt: 0, prop: null,
        };

        const streak = {
            count: 0, multiplier: 1, nextHitNoteHz: STREAK_BASE_HZ, expiresAt: 0,
        };

        // ----- pickup approach prop (one factory, type-keyed timbre) -----
        function makePowerUpPickupSound(type, {y = 0} = {}) {
            const ac = syngen.context();
            const bus = audioChannels.groundProps.createBus(`powerUp:${type}`);
            const panner = ac.createStereoPanner();
            panner.connect(bus);
            const proxGain = ac.createGain();
            proxGain.gain.value = syngen.fn.fromDb(POWERUP_GAIN_MIN_DB);
            proxGain.connect(panner);

            let cleanup = () => {};
            let scheduleCycle = () => {};
            let setDoppler = () => {};
            let cycleTotal = 1.0;

            if (type === 'shield') {
                // Warm sine-FM pad with slow 4 Hz tremolo. C4 carrier, sine mod at 1.5x.
                const synth = syngen.synth.fm({
                    carrierFrequency: 261.63, carrierType: 'sine',
                    modFrequency: 261.63 * 1.5, modType: 'sine',
                    modDepth: 12, gain: 0,
                }).connect(proxGain);
                const lfo = ac.createOscillator();
                lfo.type = 'sine';
                lfo.frequency.value = 4;
                const lfoDepth = ac.createGain();
                lfoDepth.gain.value = 0.2;
                lfo.connect(lfoDepth).connect(synth.param.gain);
                lfo.start();
                cycleTotal = 1.6;
                scheduleCycle = (t0) => {
                    const g = synth.param.gain;
                    const peak = syngen.fn.fromDb(-3);
                    g.cancelScheduledValues(t0);
                    g.setValueAtTime(0, t0);
                    g.linearRampToValueAtTime(peak, t0 + 0.3);
                    g.setValueAtTime(peak, t0 + cycleTotal - 0.4);
                    g.linearRampToValueAtTime(0, t0 + cycleTotal);
                };
                setDoppler = (mul) => {
                    const now = syngen.time();
                    synth.param.frequency.setTargetAtTime(261.63 * mul, now, 0.03);
                    synth.param.mod.frequency.setTargetAtTime(261.63 * 1.5 * mul, now, 0.03);
                };
                cleanup = () => { try { synth.stop(); lfo.stop(); } catch (e) {} };
            } else if (type === 'rocket') {
                // Bandpassed noise that breathes: swells up then decays back to a
                // non-zero floor (never to silence) so it stays audible while you
                // chase more at 150 mph, with a white-noise "burn" burst fired
                // after each swell to read as the rocket engine igniting.
                const ROCKET_FLOOR = 0.18;   // gain never drops below this — keeps it audible
                const ROCKET_PEAK = 0.9;
                const src = ac.createBufferSource();
                src.buffer = makeWhiteNoiseBuffer();
                src.loop = true;
                src.start();

                // Tonal body — bandpassed noise that swells and decays.
                const bp = ac.createBiquadFilter();
                bp.type = 'bandpass';
                bp.frequency.value = 900;
                bp.Q.value = 4;
                src.connect(bp);
                const ng = ac.createGain();
                ng.gain.value = ROCKET_FLOOR;
                bp.connect(ng).connect(proxGain);

                // Burn burst — broader lowpassed noise that fires just after the
                // swell crests, like the engine catching. Own gain so it punches
                // over the sustained body, then falls away before the next cycle.
                const burnLp = ac.createBiquadFilter();
                burnLp.type = 'lowpass';
                burnLp.frequency.value = 1400;
                src.connect(burnLp);
                const burnGain = ac.createGain();
                burnGain.gain.value = 0;
                burnLp.connect(burnGain).connect(proxGain);

                cycleTotal = 0.9;
                scheduleCycle = (t0) => {
                    // Body: floor → peak → back to floor, never silent.
                    const g = ng.gain;
                    g.cancelScheduledValues(t0);
                    g.setValueAtTime(ROCKET_FLOOR, t0);
                    g.linearRampToValueAtTime(ROCKET_PEAK, t0 + 0.22);
                    g.exponentialRampToValueAtTime(ROCKET_FLOOR, t0 + cycleTotal);
                    // Burn burst: ignites just after the swell crests, fast decay.
                    const b = burnGain.gain;
                    b.cancelScheduledValues(t0);
                    b.setValueAtTime(0, t0 + 0.20);
                    b.linearRampToValueAtTime(0.7, t0 + 0.26);
                    b.exponentialRampToValueAtTime(0.001, t0 + 0.6);
                    b.setValueAtTime(0, t0 + cycleTotal);
                };
                setDoppler = (mul) => {
                    const now = syngen.time();
                    bp.frequency.setTargetAtTime(900 * mul, now, 0.03);
                    burnLp.frequency.setTargetAtTime(1400 * mul, now, 0.03);
                };
                cleanup = () => { try { src.stop(); } catch (e) {} };
            } else {
                // hornBall: two-ping bouncing FM ball, bell-ish (3.0× modulator).
                const synth = syngen.synth.fm({
                    carrierFrequency: 220, carrierType: 'sine',
                    modFrequency: 220 * 3.0, modType: 'sine',
                    modDepth: 220, gain: 0,
                }).connect(proxGain);
                cycleTotal = 0.6;
                scheduleCycle = (t0) => {
                    const g = synth.param.gain;
                    const peak = syngen.fn.fromDb(-6);
                    g.cancelScheduledValues(t0);
                    g.setValueAtTime(0, t0);
                    g.linearRampToValueAtTime(peak, t0 + 0.01);
                    g.exponentialRampToValueAtTime(0.001, t0 + 0.15);
                    g.setValueAtTime(0, t0 + 0.25);
                    g.linearRampToValueAtTime(peak * 0.6, t0 + 0.26);
                    g.exponentialRampToValueAtTime(0.001, t0 + 0.45);
                    g.setValueAtTime(0, t0 + cycleTotal);
                };
                setDoppler = (mul) => {
                    const now = syngen.time();
                    synth.param.frequency.setTargetAtTime(220 * mul, now, 0.03);
                    synth.param.mod.frequency.setTargetAtTime(220 * 3.0 * mul, now, 0.03);
                };
                cleanup = () => { try { synth.stop(); } catch (e) {} };
            }

            const prop = {
                proxGain, panner, bus, cycleTotal, scheduleCycle, setDoppler,
                setVector({y = 0} = {}) {
                    panner.pan.setTargetAtTime(yToPan(y), syngen.time(), 0.05);
                },
                destroy() {
                    cleanup();
                    setTimeout(() => {
                        try { panner.disconnect(); } catch (e) {}
                        try { bus.disconnect(); } catch (e) {}
                    }, 60);
                },
            };
            panner.pan.value = yToPan(y);
            return prop;
        }

        // ----- coin prop (rocket-only) -----
        function makeCoinSound({y = 0, channel = 'groundProps'} = {}) {
            const ac = syngen.context();
            const bus = audioChannels[channel].createBus('coin');
            const panner = ac.createStereoPanner();
            panner.connect(bus);
            const proxGain = ac.createGain();
            proxGain.gain.value = syngen.fn.fromDb(-22);
            proxGain.connect(panner);

            const oscA = ac.createOscillator();
            oscA.type = 'triangle';
            oscA.frequency.value = 880;
            const gA = ac.createGain();
            gA.gain.value = 0;
            oscA.connect(gA).connect(proxGain);
            oscA.start();

            const oscB = ac.createOscillator();
            oscB.type = 'triangle';
            oscB.frequency.value = 1760;
            const gB = ac.createGain();
            gB.gain.value = 0;
            oscB.connect(gB).connect(proxGain);
            oscB.start();

            const COIN_A_BASE = 880;
            const COIN_B_BASE = 1760;
            const prop = {
                proxGain, gA: gA.gain, gB: gB.gain, panner, bus,
                setVector({y = 0} = {}) {
                    panner.pan.setTargetAtTime(yToPan(y), syngen.time(), 0.05);
                },
                setDoppler(mul) {
                    const now = syngen.time();
                    oscA.frequency.setTargetAtTime(COIN_A_BASE * mul, now, 0.03);
                    oscB.frequency.setTargetAtTime(COIN_B_BASE * mul, now, 0.03);
                },
                destroy() {
                    try { oscA.stop(); oscB.stop(); } catch (e) {}
                    setTimeout(() => {
                        try { panner.disconnect(); } catch (e) {}
                        try { bus.disconnect(); } catch (e) {}
                    }, 60);
                },
            };
            panner.pan.value = yToPan(y);
            return prop;
        }

        const COIN_CYCLE_TOTAL = 0.75;
        function scheduleCoinCycle(t0, target) {
            const c = target || coin;
            if (!c.prop) return;
            const peak = syngen.fn.fromDb(-9);
            const attack = 0.015;
            // Low note is a short lead-in; the high note is 4× its length and
            // begins while the low note is still fading (overlap), then runs to
            // the end of the cycle so there's no trailing silence.
            const overlap = 0.05;
            const firstLen = (COIN_CYCLE_TOTAL + overlap) / 5; // low note ≈ 0.16s
            const secondStart = firstLen - overlap;            // high note onset, mid low-note fade
            const gA = c.prop.gA;
            const gB = c.prop.gB;
            gA.cancelScheduledValues(t0);
            gA.setValueAtTime(0, t0);
            gA.linearRampToValueAtTime(peak, t0 + attack);
            gA.linearRampToValueAtTime(0, t0 + firstLen);
            gA.setValueAtTime(0, t0 + COIN_CYCLE_TOTAL);
            gB.cancelScheduledValues(t0);
            gB.setValueAtTime(0, t0);
            gB.setValueAtTime(0, t0 + secondStart);
            gB.linearRampToValueAtTime(peak, t0 + secondStart + attack);
            gB.linearRampToValueAtTime(0, t0 + COIN_CYCLE_TOTAL);
            c.nextCycleAt = t0 + COIN_CYCLE_TOTAL;
        }

        // ----- projectile travel prop (horn-ball) -----
        function makeProjectileSound({y = 0} = {}) {
            const ac = syngen.context();
            const bus = audioChannels.props.createBus('projectile');
            const panner = ac.createStereoPanner();
            panner.connect(bus);
            const proxGain = ac.createGain();
            proxGain.gain.value = syngen.fn.fromDb(-10);
            proxGain.connect(panner);

            const carrier = ac.createOscillator();
            carrier.type = 'sawtooth';
            carrier.frequency.value = 600;

            const am = ac.createGain();
            am.gain.value = 0.5;
            const lfo = ac.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = 18;
            const lfoDepth = ac.createGain();
            lfoDepth.gain.value = 0.5;
            lfo.connect(lfoDepth).connect(am.gain);

            carrier.connect(am).connect(proxGain);
            carrier.start();
            lfo.start();

            const prop = {
                proxGain, carrier, panner, bus,
                setVector({y = 0} = {}) {
                    panner.pan.setTargetAtTime(yToPan(y), syngen.time(), 0.05);
                },
                setPitch(hz) {
                    carrier.frequency.setTargetAtTime(hz, syngen.time(), 0.05);
                },
                destroy() {
                    try { carrier.stop(); lfo.stop(); } catch (e) {}
                    setTimeout(() => {
                        try { panner.disconnect(); } catch (e) {}
                        try { bus.disconnect(); } catch (e) {}
                    }, 60);
                },
            };
            panner.pan.value = yToPan(y);
            return prop;
        }

        // ----- one-shots -----
        function playPowerUpDeniedBuzz() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const dur = 0.3;
            const sawPeak = syngen.fn.fromDb(-8);
            const triPeak = sawPeak * 0.5;
            // D2 sawtooth
            const saw = ac.createOscillator();
            saw.type = 'sawtooth';
            saw.frequency.value = 73.42;
            const sawGain = ac.createGain();
            sawGain.gain.setValueAtTime(0, now);
            sawGain.gain.linearRampToValueAtTime(sawPeak, now + 0.008);
            sawGain.gain.setValueAtTime(sawPeak, now + dur - 0.04);
            sawGain.gain.linearRampToValueAtTime(0, now + dur);
            saw.connect(sawGain).connect(dest);
            saw.start(now);
            saw.stop(now + dur + 0.02);
            // D3 triangle, half amplitude
            const tri = ac.createOscillator();
            tri.type = 'triangle';
            tri.frequency.value = 146.83;
            const triGain = ac.createGain();
            triGain.gain.setValueAtTime(0, now);
            triGain.gain.linearRampToValueAtTime(triPeak, now + 0.008);
            triGain.gain.setValueAtTime(triPeak, now + dur - 0.04);
            triGain.gain.linearRampToValueAtTime(0, now + dur);
            tri.connect(triGain).connect(dest);
            tri.start(now);
            tri.stop(now + dur + 0.02);
        }

        // Risset-style bloom — three sine partials of C5 with stacked decays.
        function playShieldBloom() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const base = 523.25; // C5
            [
                { mul: 1, ampDb: -6 },
                { mul: 2, ampDb: -10 },
                { mul: 3, ampDb: -14 },
            ].forEach(({ mul, ampDb }) => {
                const osc = ac.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = base * mul;
                const g = ac.createGain();
                g.gain.setValueAtTime(0, now);
                g.gain.linearRampToValueAtTime(syngen.fn.fromDb(ampDb), now + 0.03);
                g.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + 0.5);
                osc.connect(g).connect(dest);
                g.connect(reverb.send);
                osc.start(now);
                osc.stop(now + 0.52);
            });
        }

        // Shield count indicator — N quick beeps for N shields remaining, or one
        // longer buzz if the last shield was just consumed.
        function playShieldCountIndicator(count) {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time() + 0.55; // start after the bloom tail
            if (count === 0) {
                const dur = 0.18;
                const osc = ac.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.value = 220;
                const lp = ac.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 600;
                const g = ac.createGain();
                g.gain.setValueAtTime(0, now);
                g.gain.linearRampToValueAtTime(syngen.fn.fromDb(-10), now + 0.012);
                g.gain.setValueAtTime(syngen.fn.fromDb(-10), now + dur - 0.04);
                g.gain.linearRampToValueAtTime(0, now + dur);
                osc.connect(lp).connect(g).connect(dest);
                osc.start(now);
                osc.stop(now + dur + 0.02);
            } else {
                const beepDur = 0.055;
                const beepGap = 0.09;
                for (let i = 0; i < count; i++) {
                    const t = now + i * beepGap;
                    const osc = ac.createOscillator();
                    osc.type = 'sine';
                    osc.frequency.value = 1320;
                    const g = ac.createGain();
                    g.gain.setValueAtTime(0, t);
                    g.gain.linearRampToValueAtTime(syngen.fn.fromDb(-12), t + 0.005);
                    g.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, t + beepDur);
                    osc.connect(g).connect(dest);
                    osc.start(t);
                    osc.stop(t + beepDur + 0.01);
                }
            }
        }

        // Explosion — filtered noise burst + low sine thump. size: 'small' | 'large'.
        function playExplosion(size) {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const large = size === 'large';
            const noiseDur = large ? 0.6 : 0.25;
            const thumpDur = large ? 0.55 : 0.25;

            const src = ac.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            const lp = ac.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.setValueAtTime(large ? 2500 : 1800, now);
            lp.frequency.exponentialRampToValueAtTime(large ? 200 : 400, now + noiseDur);
            const ng = ac.createGain();
            ng.gain.setValueAtTime(0, now);
            ng.gain.linearRampToValueAtTime(large ? 0.9 : 0.6, now + 0.008);
            ng.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + noiseDur);
            src.connect(lp).connect(ng).connect(dest);
            ng.connect(reverb.send);
            src.start(now);
            src.stop(now + noiseDur + 0.02);

            const sub = ac.createOscillator();
            sub.type = 'sine';
            sub.frequency.setValueAtTime(large ? 90 : 140, now);
            sub.frequency.exponentialRampToValueAtTime(large ? 35 : 60, now + thumpDur);
            const sg = ac.createGain();
            sg.gain.setValueAtTime(0, now);
            sg.gain.linearRampToValueAtTime(syngen.fn.fromDb(large ? -4 : -8), now + 0.01);
            sg.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + thumpDur);
            sub.connect(sg).connect(dest);
            sg.connect(reverb.send);
            sub.start(now);
            sub.stop(now + thumpDur + 0.02);
        }

        // Streak chirp — two sines (f, 2f), triangle AM at f/2.
        function playStreakChirp(freq) {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const dur = 0.18;

            const am = ac.createGain();
            am.gain.value = 0.7;
            const lfo = ac.createOscillator();
            lfo.type = 'triangle';
            lfo.frequency.value = freq / 2;
            const lfoDepth = ac.createGain();
            lfoDepth.gain.value = 0.3;
            lfo.connect(lfoDepth).connect(am.gain);

            const env = ac.createGain();
            env.gain.setValueAtTime(0, now);
            env.gain.linearRampToValueAtTime(syngen.fn.fromDb(-8), now + 0.01);
            env.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + dur);

            const oscA = ac.createOscillator();
            oscA.type = 'sine';
            oscA.frequency.value = freq;
            const oscB = ac.createOscillator();
            oscB.type = 'sine';
            oscB.frequency.value = freq * 2;
            const oscBGain = ac.createGain();
            oscBGain.gain.value = 0.6;
            oscB.connect(oscBGain);

            oscA.connect(am);
            oscBGain.connect(am);
            am.connect(env).connect(dest);
            oscA.start(now);
            oscB.start(now);
            lfo.start(now);
            oscA.stop(now + dur + 0.02);
            oscB.stop(now + dur + 0.02);
            lfo.stop(now + dur + 0.02);
        }

        // 25%-duty pulse wave via Fourier series — cached, built lazily once the
        // AudioContext exists. Imag coefficients only (sine series); DC dropped.
        let pulseWave25 = null;
        function getPulseWave25() {
            if (pulseWave25) return pulseWave25;
            const ac = syngen.context();
            const N = 64;
            const real = new Float32Array(N);
            const imag = new Float32Array(N);
            const duty = 0.25;
            for (let n = 1; n < N; n++) {
                imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
            }
            pulseWave25 = ac.createPeriodicWave(real, imag);
            return pulseWave25;
        }

        // Streak-death cue: 5 short 25%-pulse blips sweeping 2150 Hz → 308 Hz.
        function playStreakDeath() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const wave = getPulseWave25();
            const startHz = 2150, endHz = 308;
            const blips = 5, dur = 0.08, gap = 0.002;
            for (let i = 0; i < blips; i++) {
                const t = i / (blips - 1);
                const freq = startHz * Math.pow(endHz / startHz, t);
                const t0 = now + i * (dur + gap);
                const osc = ac.createOscillator();
                osc.setPeriodicWave(wave);
                osc.frequency.value = freq;
                const env = ac.createGain();
                env.gain.setValueAtTime(0, t0);
                env.gain.linearRampToValueAtTime(syngen.fn.fromDb(-10), t0 + 0.005);
                env.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, t0 + dur);
                osc.connect(env).connect(dest);
                osc.start(t0);
                osc.stop(t0 + dur + 0.02);
            }
        }

        function playCoinCollect(baseHz = 880) {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const dur = 0.18;
            [baseHz, baseHz * 1.5, baseHz * 2].forEach((f, i) => {
                const freq = Math.min(f, COIN_COLLECT_MAX_HZ);
                const t0 = now + i * 0.04;
                const osc = ac.createOscillator();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, t0);
                osc.frequency.exponentialRampToValueAtTime(freq * 1.08, t0 + dur);
                const g = ac.createGain();
                g.gain.setValueAtTime(0, t0);
                g.gain.linearRampToValueAtTime(syngen.fn.fromDb(-10), t0 + 0.008);
                g.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, t0 + dur);
                osc.connect(g).connect(dest);
                g.connect(reverb.send);
                osc.start(t0);
                osc.stop(t0 + dur + 0.02);
            });
        }

        // Clicky pickup arpeggio — three short square+noise notes climbing a major
        // triad (C5/E5/G5). Each note is a stiff 50ms blip with a noise transient
        // riding the attack so it reads as "click-click-click" rather than tonal.
        function playPowerUpPickupChime() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const t0 = syngen.time();
            const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
            const stagger = 0.07;
            const noteDur = 0.06;

            notes.forEach((freq, i) => {
                const start = t0 + i * stagger;
                const end = start + noteDur;

                const sq = ac.createOscillator();
                sq.type = 'square';
                sq.frequency.value = freq;
                const sqGain = ac.createGain();
                sqGain.gain.setValueAtTime(0, start);
                sqGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(-12), start + 0.004);
                sqGain.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, end);
                sq.connect(sqGain).connect(dest);
                sqGain.connect(reverb.send);
                sq.start(start);
                sq.stop(end + 0.01);

                const sub = ac.createOscillator();
                sub.type = 'sine';
                sub.frequency.value = freq / 2;
                const subGain = ac.createGain();
                subGain.gain.setValueAtTime(0, start);
                subGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(-10), start + 0.005);
                subGain.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, end + 0.02);
                sub.connect(subGain).connect(dest);
                subGain.connect(reverb.send);
                sub.start(start);
                sub.stop(end + 0.03);

                const src = ac.createBufferSource();
                src.buffer = makeWhiteNoiseBuffer();
                const hp = ac.createBiquadFilter();
                hp.type = 'highpass';
                hp.frequency.value = 2000;
                const ng = ac.createGain();
                ng.gain.setValueAtTime(0, start);
                ng.gain.linearRampToValueAtTime(syngen.fn.fromDb(-14), start + 0.001);
                ng.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, start + 0.025);
                src.connect(hp).connect(ng).connect(dest);
                ng.connect(reverb.send);
                src.start(start);
                src.stop(start + 0.03);
            });
        }

        // Power-up expire — two AM voices, both sweep 1400 Hz → 180 Hz,
        // the second voice taking 1.25× as long so it lags behind the first.
        // Slow attack (no transient), louder than the other cues so it cuts
        // through, fades out near the end.
        function playPowerUpExpire() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const totalDur = 0.85;
            const peakDb = -3;

            function voice(sweepDur, gainDbOffset) {
                const osc = ac.createOscillator();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(1400, now);
                osc.frequency.exponentialRampToValueAtTime(180, now + sweepDur);

                const am = ac.createGain();
                am.gain.value = 0.6;
                const lfo = ac.createOscillator();
                lfo.type = 'sine';
                lfo.frequency.value = 11;
                const lfoDepth = ac.createGain();
                lfoDepth.gain.value = 0.4;
                lfo.connect(lfoDepth).connect(am.gain);

                const env = ac.createGain();
                const peak = syngen.fn.fromDb(peakDb + gainDbOffset);
                env.gain.setValueAtTime(0, now);
                env.gain.linearRampToValueAtTime(peak, now + 0.18);
                env.gain.setValueAtTime(peak, now + totalDur - 0.4);
                env.gain.linearRampToValueAtTime(0, now + totalDur);

                osc.connect(am).connect(env).connect(dest);
                env.connect(reverb.send);
                osc.start(now);
                lfo.start(now);
                osc.stop(now + totalDur + 0.05);
                lfo.stop(now + totalDur + 0.05);
            }

            voice(1.0, 0);
            voice(1.25, -3);
        }

        // HUD: pie-slice timer + icon box for the active power-up.
        const POWERUP_ICON_COLORS = { shield: '#33ccff', rocket: '#ff8833', hornBall: '#cc66ff' };
        function updatePowerUpHud() {
            const timer = document.getElementById('power-up-timer');
            const slice = document.getElementById('power-up-timer-slice');
            const iconSvg = document.getElementById('power-up-icon');
            if (!activePowerUp) {
                if (!timer.hasAttribute('hidden')) timer.setAttribute('hidden', '');
                if (iconSvg.dataset.type) {
                    iconSvg.dataset.type = '';
                    iconSvg.innerHTML = '';
                }
                return;
            }
            timer.removeAttribute('hidden');
            const now = syngen.time();
            const remaining = Math.max(0, activePowerUp.expiresAt - now);
            if (remaining > (activePowerUp.peakRemaining || 0)) {
                activePowerUp.peakRemaining = remaining;
            }
            const peak = activePowerUp.peakRemaining || 1;
            const frac = Math.max(0, Math.min(1, remaining / peak));

            const cx = 25, cy = 25, r = 22;
            if (frac >= 0.999) {
                // Full circle — draw as two half-arcs so SVG renders it.
                slice.setAttribute('d',
                    `M ${cx},${cy - r} A ${r},${r} 0 1 1 ${cx},${cy + r} A ${r},${r} 0 1 1 ${cx},${cy - r} Z`);
            } else if (frac <= 0.001) {
                slice.setAttribute('d', '');
            } else {
                const theta = frac * 2 * Math.PI;
                const endX = cx + r * Math.sin(theta);
                const endY = cy - r * Math.cos(theta);
                const largeArc = theta > Math.PI ? 1 : 0;
                slice.setAttribute('d',
                    `M ${cx},${cy} L ${cx},${cy - r} A ${r},${r} 0 ${largeArc} 1 ${endX},${endY} Z`);
            }

            if (iconSvg.dataset.type !== activePowerUp.type) {
                iconSvg.dataset.type = activePowerUp.type;
                const color = POWERUP_ICON_COLORS[activePowerUp.type] || '#fff';
                iconSvg.innerHTML = `<rect x="6" y="6" width="38" height="38" fill="${color}"/>`;
            }
        }

        function playProjectileLaunch() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const dur = 0.2;

            const saw = ac.createOscillator();
            saw.type = 'sawtooth';
            saw.frequency.setValueAtTime(880, now);
            saw.frequency.exponentialRampToValueAtTime(220, now + dur);
            const sg = ac.createGain();
            sg.gain.setValueAtTime(0, now);
            sg.gain.linearRampToValueAtTime(syngen.fn.fromDb(-8), now + 0.005);
            sg.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + dur);
            saw.connect(sg).connect(dest);
            saw.start(now);
            saw.stop(now + dur + 0.02);

            const src = ac.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            const bp = ac.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 1500;
            bp.Q.value = 1.5;
            const ng = ac.createGain();
            ng.gain.setValueAtTime(0, now);
            ng.gain.linearRampToValueAtTime(0.5, now + 0.002);
            ng.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + 0.05);
            src.connect(bp).connect(ng).connect(dest);
            src.start(now);
            src.stop(now + 0.06);
        }

        // ----- rocket wind (sustained, default channel) -----
        function buildRocketWind() {
            if (rocketWind) return;
            const ac = syngen.context();
            const dest = audioChannels.default.input;
            const src = ac.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            src.loop = true;
            const lp = ac.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 3000;
            const bp = ac.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 800;
            bp.Q.value = 0.6;
            const tremolo = ac.createGain();
            tremolo.gain.value = 0.8;
            const shimmerLFO = ac.createOscillator();
            shimmerLFO.type = 'sine';
            shimmerLFO.frequency.value = 4.5;
            const shimmerDepth = ac.createGain();
            shimmerDepth.gain.value = 0.2;
            shimmerLFO.connect(shimmerDepth).connect(tremolo.gain);
            shimmerLFO.start();
            const gain = ac.createGain();
            gain.gain.value = 0;
            src.connect(lp).connect(bp).connect(tremolo).connect(gain).connect(dest);
            gain.connect(reverb.send);
            // Chorus for stereo width: two detuned delay voices, panned L/R,
            // fed into the same gain node so they ride the same volume envelope.
            const chorusMix = ac.createGain();
            chorusMix.gain.value = 0.45;
            bp.connect(chorusMix);
            const chorusDelayL = ac.createDelay(0.04);
            chorusDelayL.delayTime.value = 0.011;
            const chorusLFO_L = ac.createOscillator();
            chorusLFO_L.type = 'sine';
            chorusLFO_L.frequency.value = 0.7;
            const chorusLFO_LDepth = ac.createGain();
            chorusLFO_LDepth.gain.value = 0.003;
            chorusLFO_L.connect(chorusLFO_LDepth).connect(chorusDelayL.delayTime);
            chorusLFO_L.start();
            const panL = ac.createStereoPanner();
            panL.pan.value = -0.65;
            chorusMix.connect(chorusDelayL).connect(panL).connect(gain);
            const chorusDelayR = ac.createDelay(0.04);
            chorusDelayR.delayTime.value = 0.015;
            const chorusLFO_R = ac.createOscillator();
            chorusLFO_R.type = 'sine';
            chorusLFO_R.frequency.value = 1.1;
            const chorusLFO_RDepth = ac.createGain();
            chorusLFO_RDepth.gain.value = 0.003;
            chorusLFO_R.connect(chorusLFO_RDepth).connect(chorusDelayR.delayTime);
            chorusLFO_R.start();
            const panR = ac.createStereoPanner();
            panR.pan.value = 0.65;
            chorusMix.connect(chorusDelayR).connect(panR).connect(gain);
            src.start();
            rocketWind = { src, lp, bp, tremolo, shimmerLFO, chorusLFO_L, chorusLFO_R, gain };
        }
        function destroyRocketWind() {
            if (!rocketWind) return;
            try { rocketWind.shimmerLFO.stop(); } catch (e) {}
            try { rocketWind.chorusLFO_L.stop(); } catch (e) {}
            try { rocketWind.chorusLFO_R.stop(); } catch (e) {}
            try { rocketWind.src.stop(); } catch (e) {}
            try { rocketWind.gain.disconnect(); } catch (e) {}
            rocketWind = null;
        }
        function updateRocketWind() {
            if (!rocketWind) return;
            const t = Math.max(0, Math.min(1, (speed - 100) / 50));
            const now = syngen.time();
            rocketWind.gain.gain.setTargetAtTime(syngen.fn.fromDb(-28 + 12 * t), now, 0.08);
            rocketWind.bp.frequency.setTargetAtTime(600 + 1800 * t, now, 0.08);
        }

        // ----- spawning / queueing -----
        function powerUpSpawnChance() {
            const speedBuckets = Math.floor(highSpeedSeconds / POWERUP_SPEED_STEP);
            return Math.min(POWERUP_MAX_CHANCE,
                POWERUP_BASE_CHANCE
                + speedBuckets * POWERUP_SPEED_NUDGE);
        }

        // Power-up cadence is governed by the world generator's power-up slots,
        // each rolled against powerUpSpawnChance() at materialization.

        function spawnPowerUpPickup(laneArg, distArg, typeArg) {
            const type = typeArg !== undefined ? typeArg : POWERUP_TYPES[Math.floor(rand() * POWERUP_TYPES.length)];
            powerUpPickup.type = type;
            powerUpPickup.lane = laneArg !== undefined ? laneArg : Math.floor(rand() * 3);
            powerUpPickup.distance = distArg !== undefined ? distArg : 100;
            powerUpPickup.active = true;
            powerUpPickup.consumed = false;
            powerUpPickup.prop = makePowerUpPickupSound(type, {
                y: (smoothedLane - powerUpPickup.lane) * LANE_SPACING,
            });
            powerUpPickup.nextCycleAt = syngen.time();
            const positionWord = powerUpPickup.lane === lane
                ? "ahead in your lane"
                : (powerUpPickup.lane < lane ? "ahead on your left" : "ahead on your right");
            announce(`${POWERUP_PRETTY[type]} power-up ${positionWord}.`, {category: 'powerups'});
        }

        function clearPowerUpPickup() {
            if (powerUpPickup.prop) {
                powerUpPickup.prop.destroy();
                powerUpPickup.prop = null;
            }
            powerUpPickup.active = false;
            powerUpPickup.consumed = false;
            powerUpPickup.type = null;
            rumble.clearSource('powerUpPickup');
        }

        function updatePowerUpPickupAudio() {
            if (!powerUpPickup.active || !powerUpPickup.prop) return;
            powerUpPickup.prop.setVector({
                y: (smoothedLane - powerUpPickup.lane) * LANE_SPACING,
            });
            const proximity = Math.max(0, 1 - Math.abs(powerUpPickup.distance) / 100);
            const gainDb = POWERUP_GAIN_MIN_DB + (POWERUP_GAIN_MAX_DB - POWERUP_GAIN_MIN_DB) * proximity;
            const now = syngen.time();
            powerUpPickup.prop.proxGain.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);
            powerUpPickup.prop.setDoppler(dopplerMultiplier(powerUpPickup.distance));
            if (now >= powerUpPickup.nextCycleAt) {
                powerUpPickup.prop.scheduleCycle(powerUpPickup.nextCycleAt);
                powerUpPickup.nextCycleAt += powerUpPickup.prop.cycleTotal;
            }

            // Approach pattern: three quick right-side pulses paired with one
            // long left pulse at half intensity, length matched to the three
            // shorts. Period 1.2s, scaled by proximity so it builds.
            const period = 1.2;
            const t = syngen.time() % period;
            let r = 0, l = 0;
            const rightPulses = [[0.00, 0.10], [0.16, 0.26], [0.32, 0.42]];
            for (const [s, e] of rightPulses) {
                if (t >= s && t < e) { r = 1.0; break; }
            }
            if (t >= 0.00 && t < 0.42) l = 0.5;
            rumble.setSource('powerUpPickup', l * proximity, r * proximity, powerUpPickup.lane === lane);
        }

        function pushPowerUp(type) {
            stats.powerUpsCollected += 1;
            if (type in stats.powerUpsByType) stats.powerUpsByType[type] += 1;
            playPowerUpPickupChime();
            rumble.pulse(0, 1.0, 0.10);
            if (stats.powerUpsCollected % 10 === 0) {
                const steps = (stats.powerUpsCollected / 10) - 1;
                const mult = Math.min(2.0, 1.0 + 0.05 * steps);
                const bonus = Math.round(200 * mult);
                score += bonus;
                announce(`Power-up milestone. ${stats.powerUpsCollected} collected. Plus ${bonus} points.`, {category: 'powerups'});
            }
            if (type === 'shield') {
                if (shieldCount < 3) shieldCount++;
                announce(`Shield collected. ${shieldCount} of 3 active.`, {category: 'powerups'});
                return;
            }
            if (type === 'rocket' && activePowerUp && activePowerUp.type === 'rocket') {
                const now = syngen.time();
                activePowerUp.expiresAt += ROCKET_STACK_EXTEND;
                activePowerUp.peakRemaining = activePowerUp.expiresAt - now;
                rocketBoostActive = true;
                rocketBoostExpiresAt = now + ROCKET_BOOST_DURATION;
                targetSpeed = ROCKET_BOOST_SPEED;
                playCue(880, 0.08, 'square', -10);
                playCue(1320, 0.1, 'square', -10);
                announce(`Rocket stacked. Plus ${ROCKET_STACK_EXTEND} seconds. Speed burst!`, {category: 'powerups'});
                return;
            }
            if (powerUpQueue.length >= POWERUP_MAX_QUEUE) powerUpQueue.shift();
            powerUpQueue.push(type);
            announce(`${POWERUP_PRETTY[type]} collected. ${powerUpQueue.length} of ${POWERUP_MAX_QUEUE} in queue.`, {category: 'powerups'});
        }

        // ----- activation / deactivation -----
        function activatePowerUp(type) {
            const now = syngen.time();
            rumble.pulse(0, 1.0, 0.18);
            if (type === 'rocket') {
                // At critical health the engine can't take the extra load — light
                // the rocket and the whole engine block goes. Big bang, run ends.
                if (health < HEALTH_MISFIRE_GATE) {
                    playExplosion('large');
                    rumble.pulse(1, 1, 0.6);
                    announce(`Engine detonated! Rocket overload.`);
                    health = 0;
                    gameOver("You blew your engine by activating a rocket when it was critically damaged!");
                    return;
                }
                activePowerUp = { type, expiresAt: now + ROCKET_DURATION, peakRemaining: ROCKET_DURATION, startedAt: now };
                rocketRunSeconds = 0;
                rocketPrevTargetSpeed = targetSpeed;
                targetSpeed = ROCKET_TARGET_SPEED;
                buildRocketWind();
                coin.nextSpawnAt = now + COIN_GAP_MIN + rand() * (COIN_GAP_MAX - COIN_GAP_MIN);
                // Gas cans during rocket come from the world generator at the
                // same cadence as normal; a same-lane pickup extends the rocket
                // by ROCKET_GASCAN_EXTEND seconds (handled in loop.js).
                announce(`Rocket engaged.`, {category: 'powerups'});
                playProjectileLaunch();
            } else if (type === 'hornBall') {
                activePowerUp = { type, expiresAt: now + HORNBALL_DURATION, peakRemaining: HORNBALL_DURATION };
                announce(`Horn ball engaged. 60 seconds.`, {category: 'powerups'});
                playCue(330, 0.1, 'square', -10);
                playCue(440, 0.12, 'square', -10);
            }
        }

        function deactivatePowerUp(reason) {
            if (!activePowerUp) return;
            const type = activePowerUp.type;
            if (reason === 'expired') playPowerUpExpire();
            if (type === 'rocket') {
                destroyRocketWind();
                rocketBoostActive = false;
                targetSpeed = Math.min(rocketPrevTargetSpeed, 100);
                clearCoin();
                // Tally the run length and pay out 300 points per minute aloft.
                const duration = Math.max(0, syngen.time() - activePowerUp.startedAt);
                stats.rocketDurations.push(duration);
                const bonus = Math.round((duration / 60) * ROCKET_END_POINTS_PER_MIN);
                if (bonus > 0) score += bonus;
                if (reason === 'expired') {
                    announce(
                        bonus > 0
                            ? `Rocket expired. Plus ${bonus} points for ${Math.round(duration)} seconds of rocket time.`
                            : `Rocket expired.`,
                        {category: 'powerups'});
                }
            } else if (type === 'hornBall') {
                if (reason === 'expired') announce(`Horn ball expired.`, {category: 'powerups'});
                // Projectile already in flight is allowed to live out its own timer.
            }
            activePowerUp = null;
        }

        function updateActivePowerUp(delta) {
            if (!activePowerUp) return;
            if (activePowerUp.type === 'rocket') {
                rocketRunSeconds += delta;
                if (rocketBoostActive && syngen.time() >= rocketBoostExpiresAt) {
                    rocketBoostActive = false;
                    targetSpeed = ROCKET_TARGET_SPEED;
                }
                updateRocketWind();
            }
            if (syngen.time() >= activePowerUp.expiresAt) {
                deactivatePowerUp('expired');
            }
        }

        // ----- coin -----
        function spawnCoin() {
            coin.lane = Math.floor(rand() * 3);
            coin.distance = 100;
            coin.active = true;
            coin.consumed = false;
            coin.prop = makeCoinSound({
                y: (smoothedLane - coin.lane) * LANE_SPACING,
            });
            coin.nextCycleAt = syngen.time();
        }
        function clearCoin() {
            if (coin.prop) {
                coin.prop.destroy();
                coin.prop = null;
            }
            coin.active = false;
            coin.consumed = false;
        }
        function scheduleNextCoinSpawn() {
            coin.nextSpawnAt = syngen.time() + COIN_GAP_MIN + rand() * (COIN_GAP_MAX - COIN_GAP_MIN);
        }
        function updateCoinAudio() {
            if (!coin.active || !coin.prop) return;
            coin.prop.setVector({
                y: (smoothedLane - coin.lane) * LANE_SPACING,
            });
            const proximity = Math.max(0, 1 - Math.abs(coin.distance) / 100);
            const gainDb = -19 + 16 * proximity;
            const now = syngen.time();
            coin.prop.proxGain.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);
            coin.prop.setDoppler(dopplerMultiplier(coin.distance));
            if (now >= coin.nextCycleAt) scheduleCoinCycle(coin.nextCycleAt);
        }

        // ----- projectile -----
        function spawnProjectile() {
            projectile.active = true;
            projectile.lane = lane;
            projectile.distance = 0;
            projectile.age = 0;
            projectile.expiresAt = syngen.time() + PROJECTILE_LIFETIME;
            projectile.prop = makeProjectileSound({
                y: (smoothedLane - projectile.lane) * LANE_SPACING,
            });
            stats.hornBallsFired += 1;
            playProjectileLaunch();
            rumble.pulse(0, 1.0, 0.10);
        }
        function clearProjectile() {
            if (projectile.prop) {
                projectile.prop.destroy();
                projectile.prop = null;
            }
            projectile.active = false;
        }
        function updateProjectile(delta) {
            if (!projectile.active) return;
            projectile.age += delta;
            // 2× player speed with a half-sine boost (peak 1.6× at age=2s, back to 1.0 at 4s).
            const T = 4;
            const phase = Math.min(projectile.age, T);
            const boost = 1 + 0.6 * Math.sin(Math.PI * phase / T);
            const v = 2 * Math.max(speed, 1) * boost;
            projectile.distance += (v / 100) * 90 * delta;

            projectile.prop.setVector({
                y: (smoothedLane - projectile.lane) * LANE_SPACING,
            });
            const far = Math.min(1, projectile.distance / 100);
            const gainDb = -10 - 18 * far;
            const now = syngen.time();
            projectile.prop.proxGain.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);
            projectile.prop.setPitch(600 + 200 * far);

            // Collision checks — same lane, distance within HIT_RADIUS.
            if (obstacle.active && obstacle.lane === projectile.lane
                && Math.abs(obstacle.distance - projectile.distance) < PROJECTILE_HIT_RADIUS) {
                playExplosion('small');
                rumble.pulse(0, 1.0, 0.18);
                applyStreakHit();
                stats.hornBallsHit += 1;
                const accPct = (stats.hornBallsHit / (stats.hornBallsHit + stats.hornBallsMissed)) * 100;
                if (accPct > 50) {
                    const accBonus = Math.floor((accPct - 50) / 5) * 10;
                    if (accBonus > 0) {
                        score += accBonus;
                        announce(`Accuracy bonus. Plus ${accBonus}.`, {category: 'powerups'});
                    }
                }
                clearObstacle();
                clearProjectile();
                return;
            }
            if (wrench.active && wrench.lane === projectile.lane
                && Math.abs(wrench.distance - projectile.distance) < PROJECTILE_HIT_RADIUS) {
                playExplosion('small');
                rumble.pulse(0, 1.0, 0.18);
                const penalty = 20 + Math.floor(rand() * 31);
                score -= penalty;
                stats.hornBallsMissed += 1;
                announce(`Wrench destroyed. Minus ${penalty}.`, {category: 'powerups'});
                clearWrench();
                clearProjectile();
                return;
            }
            if (gasCan.active && gasCan.lane === projectile.lane
                && Math.abs(gasCan.distance - projectile.distance) < PROJECTILE_HIT_RADIUS) {
                playExplosion('large');
                rumble.pulse(0.5, 1.0, 0.30);
                const penalty = 150 + Math.floor(rand() * 351);
                score -= penalty;
                stats.hornBallsMissed += 1;
                const dx = projectile.distance;
                const dy = (lane - gasCan.lane) * LANE_SPACING;
                const r = Math.hypot(dx, dy);
                const shielded = shieldCount > 0;
                if (r < GASCAN_BLAST_RADIUS && !shielded) {
                    const damage = Math.round(GASCAN_BLAST_DAMAGE * (1 - r / GASCAN_BLAST_RADIUS));
                    health = Math.max(0, health - damage);
                    announce(`Gas can destroyed. Minus ${penalty}. Blast damage minus ${damage} health.`, {category: 'powerups'});
                    if (health === 0) {
                        clearProjectile();
                        clearGasCan();
                        gameOver("You blew yourself up firing rocket balls at gas cans!");
                        return;
                    }
                } else {
                    announce(`Gas can destroyed. Minus ${penalty}.`, {category: 'powerups'});
                }
                clearGasCan();
                clearProjectile();
                return;
            }
            if (powerUpPickup.active && powerUpPickup.lane === projectile.lane
                && Math.abs(powerUpPickup.distance - projectile.distance) < PROJECTILE_HIT_RADIUS) {
                // Destroying a power-up: no blast, no vehicle damage, just a
                // points hit for wasting a beneficial pickup.
                playExplosion('small');
                rumble.pulse(0, 1.0, 0.18);
                const penalty = 50 + Math.floor(rand() * 101);
                score -= penalty;
                stats.hornBallsMissed += 1;
                announce(`Power-up destroyed. Minus ${penalty}.`, {category: 'powerups'});
                clearPowerUpPickup();
                clearProjectile();
                return;
            }

            if (syngen.time() >= projectile.expiresAt || projectile.distance > PROJECTILE_MAX_DISTANCE) {
                stats.hornBallsMissed += 1;
                clearProjectile();
            }
        }

        // ----- streak (horn-ball obstacle kill chain) -----
        function applyStreakHit() {
            const now = syngen.time();
            const base = 10;
            if (streak.count === 0 || now >= streak.expiresAt) {
                streak.count = 1;
                streak.multiplier = 1;
                streak.nextHitNoteHz = STREAK_BASE_HZ;
                streak.expiresAt = now + STREAK_FIRST_WINDOW;
                score += base;
            } else {
                streak.count += 1;
                streak.expiresAt = Math.min(streak.expiresAt + STREAK_EXTEND, now + STREAK_MAX_WINDOW);
                streak.multiplier = 1 + Math.log(streak.count) / Math.log(2);
                const bonus = Math.round((30 + Math.floor(rand() * 21)) * streak.multiplier);
                score += base + bonus;
            }
            playStreakChirp(streak.nextHitNoteHz);
            streak.nextHitNoteHz *= STREAK_QUARTER_TONE;
        }

        function updateStreak() {
            if (streak.count > 0 && syngen.time() >= streak.expiresAt) {
                playStreakDeath();
                streak.count = 0;
                streak.multiplier = 1;
                streak.nextHitNoteHz = STREAK_BASE_HZ;
            }
        }

        // Obstacle prop: smooth FM tone (sine carrier with sine modulator at a 1.5 ratio
        // for a slightly hollow horn-like timbre) routed through a lowpass filter we sweep
        // each frame to simulate occlusion. Stereo positioning is a plain StereoPanner
        // driven from y; forward distance cues are conveyed entirely by the manual
        // gain + filter ramps in updateObstacleAudio.
        function makeObstacleSound({x = 0, y = 0} = {}) {
            const ac = syngen.context();
            const bus = audioChannels.groundProps.createBus('obstacle');
            const panner = ac.createStereoPanner();
            panner.connect(bus);

            const synth = syngen.synth.fm({
                carrierFrequency: OBSTACLE_CARRIER_HZ,
                carrierType: 'sine',
                gain: syngen.fn.fromDb(OBSTACLE_GAIN_MIN_DB),
                modDepth: 40,
                modFrequency: OBSTACLE_CARRIER_HZ * 1.5,
                modType: 'sine',
            }).filtered({
                type: 'lowpass',
                frequency: OBSTACLE_FILTER_MIN,
                Q: 0.5,
            }).connect(panner);

            const prop = {
                synth,
                panner,
                bus,
                setVector({y = 0} = {}) {
                    panner.pan.setTargetAtTime(yToPan(y), syngen.time(), 0.05);
                },
                destroy() {
                    // Short linear fade on the synth's output gain before stopping
                    // the oscillators — otherwise we cut off a still-audible voice
                    // (proximity at OBSTACLE_DESPAWN_AT = -75 is ~0.25) and the
                    // discontinuity reads as a click/pop.
                    const now = syngen.time();
                    const fade = 0.08;
                    try {
                        const g = synth.param.gain;
                        g.cancelScheduledValues(now);
                        g.setValueAtTime(g.value, now);
                        g.linearRampToValueAtTime(0, now + fade);
                    } catch (e) {}
                    synth.stop(now + fade);
                    setTimeout(() => {
                        try { panner.disconnect(); } catch (e) {}
                        try { bus.disconnect(); } catch (e) {}
                    }, (fade + 0.05) * 1000);
                },
            };
            panner.pan.value = yToPan(y);
            return prop;
        }

        // Gas can: three bursts of bandpassed noise per cycle, each burst paired
        // with a brief FM "twang" (sine carrier, bell-ratio modulator) for the
        // metallic edge. Bursts 1 & 2 are short and steady; burst 3 is 1.5×
        // longer with a 6 Hz → 3 Hz tremolo across its fading second half.
        // The whole cycle is rescheduled on the audio clock each time the
        // previous one completes, while a master proximity gain (proxGain)
        // independently ramps with distance — same trick the obstacle uses
        // for the small soundstage.
        function makeWhiteNoiseBuffer() {
            if (makeWhiteNoiseBuffer._cache) return makeWhiteNoiseBuffer._cache;
            const ctx = syngen.context();
            const len = Math.floor(ctx.sampleRate * 0.5);
            const buf = ctx.createBuffer(1, len, ctx.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = rand() * 2 - 1;
            makeWhiteNoiseBuffer._cache = buf;
            return buf;
        }

        function makeGasCanSound({x = 0, y = 0} = {}) {
            const ac = syngen.context();
            const bus = audioChannels.groundProps.createBus('gasCan');
            const panner = ac.createStereoPanner();
            panner.connect(bus);

            const proxGain = ac.createGain();
            proxGain.gain.value = syngen.fn.fromDb(GAS_CAN_GAIN_MIN_DB);
            proxGain.connect(panner);

            const noiseSrc = ac.createBufferSource();
            noiseSrc.buffer = makeWhiteNoiseBuffer();
            noiseSrc.loop = true;
            const noiseFilt = ac.createBiquadFilter();
            noiseFilt.type = 'bandpass';
            noiseFilt.frequency.value = 1600;
            noiseFilt.Q.value = 1.2;
            const noiseGain = ac.createGain();
            noiseGain.gain.value = 0;
            noiseSrc.connect(noiseFilt).connect(noiseGain).connect(proxGain);
            noiseSrc.start();

            // 2.76× modulator — classic bell/metallic ratio.
            const twang = syngen.synth.fm({
                carrierFrequency: 520,
                carrierType: 'sine',
                gain: 0,
                modDepth: 700,
                modFrequency: 520 * 2.76,
                modType: 'sine',
            }).connect(proxGain);

            const TWANG_BASE = 520;
            const NOISE_BP_BASE = 1600;
            const prop = {
                proxGain,
                noiseSrc,
                noiseGain,
                twang,
                panner,
                bus,
                setVector({y = 0} = {}) {
                    panner.pan.setTargetAtTime(yToPan(y), syngen.time(), 0.05);
                },
                setDoppler(mul) {
                    const now = syngen.time();
                    twang.param.frequency.setTargetAtTime(TWANG_BASE * mul, now, 0.03);
                    twang.param.mod.frequency.setTargetAtTime(TWANG_BASE * 2.76 * mul, now, 0.03);
                    noiseFilt.frequency.setTargetAtTime(NOISE_BP_BASE * mul, now, 0.03);
                },
                destroy() {
                    try { noiseSrc.stop(); } catch (e) {}
                    twang.stop();
                    setTimeout(() => {
                        try { panner.disconnect(); } catch (e) {}
                        try { bus.disconnect(); } catch (e) {}
                    }, 60);
                },
            };
            panner.pan.value = yToPan(y);
            return prop;
        }

        const GC_BURST_SHORT = 0.075;
        const GC_BURST_LONG  = GC_BURST_SHORT * 1.5;
        const GC_BURST_GAP   = 0.11;
        const GC_CYCLE_TAIL  = 0.30;
        const GC_CYCLE_TOTAL = (GC_BURST_SHORT + GC_BURST_GAP) * 2 + GC_BURST_LONG + GC_CYCLE_TAIL;
        const GC_NOISE_PEAK  = 0.95;
        const GC_TWANG_PEAK  = syngen.fn.fromDb(-3);

        function scheduleGasCanBurst(prop, start, dur, withTremolo) {
            const noiseG = prop.noiseGain.gain;
            const twangG = prop.twang.param.gain;
            const attack = 0.008;
            const release = 0.04;
            noiseG.cancelScheduledValues(start);
            twangG.cancelScheduledValues(start);
            noiseG.setValueAtTime(0, start);
            twangG.setValueAtTime(0, start);
            noiseG.linearRampToValueAtTime(GC_NOISE_PEAK, start + attack);
            twangG.linearRampToValueAtTime(GC_TWANG_PEAK, start + attack);

            if (!withTremolo) {
                const holdEnd = start + dur - release;
                noiseG.setValueAtTime(GC_NOISE_PEAK, holdEnd);
                twangG.setValueAtTime(GC_TWANG_PEAK, holdEnd);
                noiseG.linearRampToValueAtTime(0, start + dur);
                twangG.linearRampToValueAtTime(0, start + dur);
            } else {
                // Steady for the first half, then tremolo + fade-out for the second.
                // Phase is integrated across the ramping frequency so 6 Hz → 3 Hz
                // produces a continuous chirp, not a discontinuity at the midpoint.
                const mid = start + dur * 0.5;
                noiseG.setValueAtTime(GC_NOISE_PEAK, mid);
                twangG.setValueAtTime(GC_TWANG_PEAK, mid);
                const trDur = dur * 0.5;
                const N = 96;
                const noiseCurve = new Float32Array(N);
                const twangCurve = new Float32Array(N);
                let phase = 0;
                const dt = trDur / (N - 1);
                for (let i = 0; i < N; i++) {
                    const u = i / (N - 1);
                    const freqHz = 6 + (3 - 6) * u;
                    if (i > 0) phase += 2 * Math.PI * freqHz * dt;
                    const trem = 0.5 + 0.5 * Math.cos(phase); // 0..1
                    const fade = 1 - u;
                    const shape = trem * fade;
                    noiseCurve[i] = GC_NOISE_PEAK * shape;
                    twangCurve[i] = GC_TWANG_PEAK * shape;
                }
                noiseG.setValueCurveAtTime(noiseCurve, mid, trDur);
                twangG.setValueCurveAtTime(twangCurve, mid, trDur);
            }
        }

        function scheduleGasCanCycle(t0) {
            if (!gasCan.prop) return;
            let t = t0;
            scheduleGasCanBurst(gasCan.prop, t, GC_BURST_SHORT, false);
            t += GC_BURST_SHORT + GC_BURST_GAP;
            scheduleGasCanBurst(gasCan.prop, t, GC_BURST_SHORT, false);
            t += GC_BURST_SHORT + GC_BURST_GAP;
            scheduleGasCanBurst(gasCan.prop, t, GC_BURST_LONG, true);
            gasCan.nextCycleAt = t0 + GC_CYCLE_TOTAL;
        }

        // Wrench prop. Two groups of three short noise bursts; group two is -3 dB
        // quieter. The bandpass cutoff is automated together with the amp envelope
        // (rising with attack, falling with release) so each burst opens up tonally
        // as it gets louder and closes as it fades — that automation is what turns
        // a bandpassed noise burst into something that reads as metallic, not whitenoise.
        // A small FM voice with a 3.13× modulator rides on top of the same envelope
        // to add a tuned metallic clang. Tight inter-cycle tail so the sound stays
        // audible against the engine at speed.
        function makeWrenchSound({y = 0} = {}) {
            const ac = syngen.context();
            const bus = audioChannels.groundProps.createBus('wrench');
            const panner = ac.createStereoPanner();
            panner.connect(bus);

            const proxGain = ac.createGain();
            proxGain.gain.value = syngen.fn.fromDb(WRENCH_GAIN_MIN_DB);
            proxGain.connect(panner);

            const noiseSrc = ac.createBufferSource();
            noiseSrc.buffer = makeWhiteNoiseBuffer();
            noiseSrc.loop = true;
            const bp = ac.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = WR_BP_LO;
            bp.Q.value = 8; // midway resonance — focused enough to be tonal, not whistly
            const noiseGain = ac.createGain();
            noiseGain.gain.value = 0;
            noiseSrc.connect(bp).connect(noiseGain).connect(proxGain);
            noiseSrc.start();

            // 3.13× — slightly off-integer modulator ratio is the classic recipe for
            // tuned-metal/struck-bar timbres (vs the bell ratios near 2.76).
            const twang = syngen.synth.fm({
                carrierFrequency: 880,
                carrierType: 'sine',
                gain: 0,
                modDepth: 600,
                modFrequency: 880 * 3.13,
                modType: 'sine',
            }).connect(proxGain);

            const WR_TWANG_BASE = 880;
            const prop = {
                proxGain,
                noiseSrc,
                noiseGain,
                bpFreq: bp.frequency,
                twang,
                panner,
                bus,
                setVector({y = 0} = {}) {
                    panner.pan.setTargetAtTime(yToPan(y), syngen.time(), 0.05);
                },
                // Wrench bandpass is actively swept by the burst envelope, so
                // we only Doppler-shift the FM voice (carrier + modulator).
                setDoppler(mul) {
                    const now = syngen.time();
                    twang.param.frequency.setTargetAtTime(WR_TWANG_BASE * mul, now, 0.03);
                    twang.param.mod.frequency.setTargetAtTime(WR_TWANG_BASE * 3.13 * mul, now, 0.03);
                },
                destroy() {
                    try { noiseSrc.stop(); } catch (e) {}
                    twang.stop();
                    setTimeout(() => {
                        try { panner.disconnect(); } catch (e) {}
                        try { bus.disconnect(); } catch (e) {}
                    }, 60);
                },
            };
            panner.pan.value = yToPan(y);
            return prop;
        }

        const WR_BURST = 0.065;
        const WR_BURST_GAP = 0.075;
        const WR_GROUP_GAP = 0.16;
        const WR_CYCLE_TAIL = 0.18;
        const WR_BP_LO = 600;
        const WR_BP_HI = 2400;
        const WR_NOISE_PEAK = 0.95;
        const WR_TWANG_PEAK_DB = -6;
        const WR_GROUP2_DB = -3;
        // 6 bursts × WR_BURST + 4 intra-group gaps + 1 inter-group gap + tail
        const WR_CYCLE_TOTAL = 6 * WR_BURST + 4 * WR_BURST_GAP + WR_GROUP_GAP + WR_CYCLE_TAIL;

        // ===== Sinkhole =====
        // Occupies two adjacent lanes (left+middle OR middle+right) for a fixed physical
        // distance (~10 s at 100 mph). The free lane is always the leftmost or rightmost.
        // Entering a blocked lane once the front edge reaches the player is instant death.
        // Spacing between sinkholes is enforced by the world generator (js/world.js).
        const SINKHOLE_ZONE_LENGTH = 900;    // distance units — 900 / 90 = 10 s at 100 mph
        const SINKHOLE_SPAWN_DISTANCE = 450; // initial distance (more warning than obstacles)
        const SINKHOLE_DESPAWN_TAIL = 200;   // units past zone back-edge before despawn
        const SINKHOLE_GAIN_MIN_DB = -30;
        const SINKHOLE_GAIN_MAX_DB = -8;
        const SINKHOLE_POINTS = 200;

        const sinkhole = {
            active: false,
            frontDistance: 0,
            freeLane: 0,          // 0 = left, 2 = right (middle never free)
            sinkholeCenter: 1.5,  // average of the two blocked lane indices
            traversalStarted: false,
            cleared: false,
            prop: null,
            nextBeepAt: 0,        // AudioContext time for next sensor beep
        };

        // ===== Ramp =====
        // A ramp occupies a single lane. Hitting it launches the player into a jump
        // whose duration scales linearly with speed (max 15s at 150 mph, ~0s at the
        // 30 mph floor, below which the player bounces instead). During the jump the
        // ground-based hazards (obstacles, sinkholes, wrenches, gas cans, power-ups)
        // pass underneath safely; air coins spawn frequently to reward the jump.
        const RAMP_MIN_SPEED = 30;
        const RAMP_MAX_AIRTIME = 15;
        const RAMP_MAX_AIRTIME_SPEED = 150;
        const RAMP_DESPAWN_AT = -50;
        // Airborne under a rocket: with no rolling resistance the rockets keep
        // pushing, so instead of bleeding speed the car climbs toward this cap.
        // On landing the rocket (if still active) settles back to its ground
        // cruise speed (ROCKET_TARGET_SPEED = 150). Engine stays at idle aloft.
        const ROCKET_AIR_SPEED = 175;
        const ROCKET_AIR_BOOST_RATE = 20;   // mph/s climb while airborne
        const RAMP_GAIN_MIN_DB = -19;
        const RAMP_GAIN_MAX_DB = -3;
        // Jump rev arc: a quick blip up to redline, then a much slower decay back
        // to idle — a real engine snapping off-load winds down on its flywheel
        // inertia, not instantly. The down phase is several times longer than the
        // up phase so the airborne idle sounds like a release, not a cut.
        const JUMP_REV_UP_DURATION = 0.25;
        const JUMP_REV_DOWN_DURATION = 1.4;
        const AIR_COIN_GAP_MIN = 0.35;
        const AIR_COIN_GAP_MAX = 0.65;
        const AIR_COIN_VALUE_MIN = 25;
        const AIR_COIN_VALUE_MAX = 150;

        const ramp = {
            lane: 1, distance: 100, active: false, consumed: false,
            prop: null, nextCycleAt: 0, pulseIndex: 0,
        };

        const airCoin = {
            lane: 1, distance: 100, active: false, consumed: false,
            prop: null, nextCycleAt: 0, nextSpawnAt: 0,
        };

        let jumping = false;
        let jumpStartedAt = 0;
        let jumpEndsAt = 0;
        let rampEverSpawned = false;

        // Landing load: after airborne decel, the car lands below targetSpeed and
        // climbs back. The engine should sound *loaded* (rougher, slightly louder)
        // during that climb, easing back to clean as speed nears the target. See
        // endJump (ramp.js) where landingDeficit is captured and updateEngineAudio
        // (engine.js) where it shapes the synth.
        let landingLoadActive = false;
        let landingDeficit = 0;

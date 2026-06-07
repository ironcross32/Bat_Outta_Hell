        function scheduleWrenchBurst(prop, start, dur, levelMul) {
            const attack = 0.006;
            const release = 0.03;
            const noiseG = prop.noiseGain.gain;
            const twangG = prop.twang.param.gain;
            const bpF = prop.bpFreq;
            const noisePeak = WR_NOISE_PEAK * levelMul;
            const twangPeak = syngen.fn.fromDb(WR_TWANG_PEAK_DB) * levelMul;

            noiseG.cancelScheduledValues(start);
            twangG.cancelScheduledValues(start);
            bpF.cancelScheduledValues(start);
            noiseG.setValueAtTime(0, start);
            twangG.setValueAtTime(0, start);
            bpF.setValueAtTime(WR_BP_LO, start);

            const peakAt = start + attack;
            noiseG.linearRampToValueAtTime(noisePeak, peakAt);
            twangG.linearRampToValueAtTime(twangPeak, peakAt);
            bpF.linearRampToValueAtTime(WR_BP_HI, peakAt);

            const holdEnd = start + dur - release;
            noiseG.setValueAtTime(noisePeak, holdEnd);
            twangG.setValueAtTime(twangPeak, holdEnd);
            bpF.setValueAtTime(WR_BP_HI, holdEnd);

            noiseG.linearRampToValueAtTime(0, start + dur);
            twangG.linearRampToValueAtTime(0, start + dur);
            bpF.linearRampToValueAtTime(WR_BP_LO, start + dur);
        }

        function scheduleWrenchCycle(t0) {
            if (!wrench.prop) return;
            let t = t0;
            for (let i = 0; i < 3; i++) {
                scheduleWrenchBurst(wrench.prop, t, WR_BURST, 1.0);
                t += WR_BURST + WR_BURST_GAP;
            }
            // Replace the trailing burst-gap with the wider inter-group gap.
            t += WR_GROUP_GAP - WR_BURST_GAP;
            const group2Mul = syngen.fn.fromDb(WR_GROUP2_DB);
            for (let i = 0; i < 3; i++) {
                scheduleWrenchBurst(wrench.prop, t, WR_BURST, group2Mul);
                t += WR_BURST + WR_BURST_GAP;
            }
            wrench.nextCycleAt = t0 + WR_CYCLE_TOTAL;
        }

        // Wrench cadence is governed by the world generator's wrench slots,
        // materialized with a health-scaled probability (wrenchSpawnChance).
        // There is no separate scheduler any more.

        // Sinkhole sound: a low ~82 Hz sine hum whose pitch is irregularly warbled by
        // bandlimited noise (LP at 8 Hz feeds the frequency AudioParam — ~8 pitch excursions
        // per second creates a bursty, gurgling wobble). The same noise also "leaks" into
        // the output through a deeper LP (180 Hz), adding a subterranean rumble beneath the
        // hum. A slow 0.25 Hz AM LFO gives the hum a gentle breathing pulse.
        function makeSinkholeSound({y = 0} = {}) {
            const ac = syngen.context();
            const bus = audioChannels.groundProps.createBus('sinkhole');
            const panner = ac.createStereoPanner();
            panner.connect(bus);

            const proxGain = ac.createGain();
            proxGain.gain.value = syngen.fn.fromDb(SINKHOLE_GAIN_MIN_DB);
            proxGain.connect(panner);

            const noiseSrc = ac.createBufferSource();
            noiseSrc.buffer = makeWhiteNoiseBuffer();
            noiseSrc.loop = true;

            // FM path: noise → LP 8 Hz → depth → hum frequency AudioParam
            const noiseModLp = ac.createBiquadFilter();
            noiseModLp.type = 'lowpass';
            noiseModLp.frequency.value = 8;
            const noiseModDepth = ac.createGain();
            noiseModDepth.gain.value = 18; // ±18 Hz pitch warble

            // Leak path: noise → LP 180 Hz → level → mix output
            const noiseLeakLp = ac.createBiquadFilter();
            noiseLeakLp.type = 'lowpass';
            noiseLeakLp.frequency.value = 180;
            const noiseLeakGain = ac.createGain();
            noiseLeakGain.gain.value = 0.28;

            // Main hum oscillator
            const hum = ac.createOscillator();
            hum.type = 'sine';
            hum.frequency.value = 82;

            // Gain node so we can AM-modulate the hum
            const humGain = ac.createGain();
            humGain.gain.value = syngen.fn.fromDb(-3);

            // Slow breathing AM (0.25 Hz)
            const breathLfo = ac.createOscillator();
            breathLfo.type = 'sine';
            breathLfo.frequency.value = 0.25;
            const breathDepth = ac.createGain();
            breathDepth.gain.value = syngen.fn.fromDb(-3) * 0.15;

            noiseSrc.connect(noiseModLp).connect(noiseModDepth).connect(hum.frequency);
            noiseSrc.connect(noiseLeakLp).connect(noiseLeakGain).connect(proxGain);
            hum.connect(humGain).connect(proxGain);
            breathLfo.connect(breathDepth).connect(humGain.gain);

            noiseSrc.start();
            hum.start();
            breathLfo.start();

            const HUM_BASE = 82;
            const prop = {
                proxGain, panner, bus,
                setVector({y = 0} = {}) {
                    panner.pan.setTargetAtTime(yToPan(y), syngen.time(), 0.05);
                },
                // The noise-warble signal sums into hum.frequency on top of
                // its base value, so retargeting the base value with
                // setTargetAtTime shifts the centre while the ±18 Hz warble
                // rides along unchanged.
                setDoppler(mul) {
                    hum.frequency.setTargetAtTime(HUM_BASE * mul, syngen.time(), 0.05);
                },
                destroy() {
                    try { noiseSrc.stop(); hum.stop(); breathLfo.stop(); } catch (e) {}
                    setTimeout(() => {
                        try { panner.disconnect(); } catch (e) {}
                        try { bus.disconnect(); } catch (e) {}
                    }, 60);
                },
            };
            panner.pan.value = yToPan(y);
            return prop;
        }

        // Sinkhole sensor cue — a 180 ms triangle-wave downward glide
        // (700 → 140 Hz) panned toward the free lane. The falling pitch is
        // unmistakably "hole" rather than a generic parking-sensor beep, so the
        // player identifies the hazard the instant the first chirp lands.
        // Cue rate ramps from ~1.5 s apart (distant) down to ~0.18 s (imminent).
        function playSinkholeSensorBeep(freeLane) {
            const ac = syngen.context();
            const now = syngen.time();
            const dur = 0.18;
            const panVal = freeLane === 0 ? -0.85 : freeLane === 2 ? 0.85 : 0;

            const panner = ac.createStereoPanner();
            panner.pan.value = panVal;
            panner.connect(syngen.mixer.input());

            const envGain = ac.createGain();
            envGain.gain.setValueAtTime(0, now);
            envGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(-8), now + 0.012);
            envGain.gain.setTargetAtTime(0, now + dur - 0.04, 0.025);
            envGain.connect(panner);

            // Triangle is harmonically richer than sine — distinctive against the
            // engine's sawtooth and the obstacle's FM voice.
            const osc = ac.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(700, now);
            osc.frequency.exponentialRampToValueAtTime(140, now + dur);
            osc.connect(envGain);

            const stop = now + dur + 0.08;
            osc.start(now); osc.stop(stop);
        }

        function spawnSinkhole(distArg) {
            // Two possible configs: sinkhole in left+middle (free=right) or middle+right (free=left)
            if (rand() < 0.5) {
                sinkhole.freeLane = 2;          // right lane free
                sinkhole.sinkholeCenter = 0.5;  // centre of blocked lanes 0+1
            } else {
                sinkhole.freeLane = 0;          // left lane free
                sinkhole.sinkholeCenter = 1.5;  // centre of blocked lanes 1+2
            }
            sinkhole.active = true;
            sinkhole.frontDistance = distArg !== undefined ? distArg : SINKHOLE_SPAWN_DISTANCE;
            sinkhole.traversalStarted = false;
            sinkhole.cleared = false;
            sinkhole.nextBeepAt = 0;
            sinkhole.prop = makeSinkholeSound({
                y: (smoothedLane - sinkhole.sinkholeCenter) * LANE_SPACING,
            });
            const freeName = laneNames[sinkhole.freeLane].replace(' Lane', '').toLowerCase();
            announce(`Sink hole, ${freeName} lane free.`, {critical: true, category: 'sinkholes'});
        }

        function clearSinkhole() {
            if (sinkhole.prop) {
                sinkhole.prop.destroy();
                sinkhole.prop = null;
            }
            sinkhole.active = false;
            sinkhole.traversalStarted = false;
            sinkhole.cleared = false;
            rumble.clearSource('sinkhole');
        }

        function updateSinkholeAudio() {
            if (!sinkhole.active || !sinkhole.prop) return;
            sinkhole.prop.setVector({
                y: (smoothedLane - sinkhole.sinkholeCenter) * LANE_SPACING,
            });
            // Approach: ramp up as front edge closes in.
            // Traversal: hold at max.
            // Receding: ramp down after back edge passes player.
            let gainDb;
            if (sinkhole.frontDistance > 0) {
                const proximity = 1 - sinkhole.frontDistance / SINKHOLE_SPAWN_DISTANCE;
                gainDb = SINKHOLE_GAIN_MIN_DB + (SINKHOLE_GAIN_MAX_DB - SINKHOLE_GAIN_MIN_DB) * proximity;
            } else if (sinkhole.frontDistance > -SINKHOLE_ZONE_LENGTH) {
                gainDb = SINKHOLE_GAIN_MAX_DB;
            } else {
                const backDist = -sinkhole.frontDistance - SINKHOLE_ZONE_LENGTH;
                const proximity = Math.max(0, 1 - backDist / SINKHOLE_DESPAWN_TAIL);
                gainDb = SINKHOLE_GAIN_MIN_DB + (SINKHOLE_GAIN_MAX_DB - SINKHOLE_GAIN_MIN_DB) * proximity;
            }
            sinkhole.prop.proxGain.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), syngen.time(), 0.05);
            sinkhole.prop.setDoppler(dopplerMultiplier(sinkhole.frontDistance));

            // Alternating L/R rumble pattern. Period 1.2s, right peaks first
            // (t=0.3s) and left peaks half a cycle later (t=0.9s). Left has a
            // 0.3 baseline because the strong/low-frequency motor takes longer
            // to spool up — dropping it to zero between pulses would produce a
            // perceptible "stall". Scaled by audio proximity so the haptics
            // approach and recede with the hazard.
            const proximity = (() => {
                if (sinkhole.frontDistance > 0)
                    return 1 - sinkhole.frontDistance / SINKHOLE_SPAWN_DISTANCE;
                if (sinkhole.frontDistance > -SINKHOLE_ZONE_LENGTH) return 1;
                const back = -sinkhole.frontDistance - SINKHOLE_ZONE_LENGTH;
                return Math.max(0, 1 - back / SINKHOLE_DESPAWN_TAIL);
            })();
            const period = 1.2;
            const phase = (syngen.time() % period) / period;
            const rightR = Math.max(0, Math.sin(2 * Math.PI * phase));
            const leftR = Math.max(0.3, -Math.sin(2 * Math.PI * phase));
            // "In the hazard's lane" = player is in a blocked lane (about to die);
            // safe (free) lane → off-lane attenuation.
            rumble.setSource('sinkhole', leftR * proximity, rightR * proximity, lane !== sinkhole.freeLane);

            // Parking sensor: beep while sinkhole is ahead and player is not yet on the free lane.
            // Rate scales with proximity (1.2 s apart when far → 0.1 s when imminent).
            if (sinkhole.frontDistance > 0 && lane !== sinkhole.freeLane) {
                const now = syngen.time();
                const prox = Math.max(0, 1 - sinkhole.frontDistance / SINKHOLE_SPAWN_DISTANCE);
                const interval = 1.5 - 1.32 * prox;
                if (now >= sinkhole.nextBeepAt) {
                    playSinkholeSensorBeep(sinkhole.freeLane);
                    sinkhole.nextBeepAt = now + interval;
                }
            }
        }

        function spawnWrench(laneArg, distArg) {
            wrench.lane = laneArg !== undefined ? laneArg : Math.floor(rand() * 3);
            wrench.distance = distArg !== undefined ? distArg : 100;
            wrench.active = true;
            wrench.consumed = false;
            wrench.prop = makeWrenchSound({
                y: (smoothedLane - wrench.lane) * LANE_SPACING,
            });
            wrench.nextCycleAt = syngen.time();
            const positionWord = wrench.lane === lane
                ? "ahead in your lane"
                : (wrench.lane < lane ? "ahead on your left" : "ahead on your right");
            announce(`Wrench ${positionWord}.`, {category: 'items'});
        }

        function clearWrench() {
            if (wrench.prop) {
                wrench.prop.destroy();
                wrench.prop = null;
            }
            wrench.active = false;
            wrench.consumed = false;
        }

        function updateWrenchAudio() {
            if (!wrench.active || !wrench.prop) return;
            wrench.prop.setVector({
                y: (smoothedLane - wrench.lane) * LANE_SPACING,
            });
            const proximity = Math.max(0, 1 - Math.abs(wrench.distance) / 100);
            const gainDb = WRENCH_GAIN_MIN_DB + (WRENCH_GAIN_MAX_DB - WRENCH_GAIN_MIN_DB) * proximity;
            const now = syngen.time();
            wrench.prop.proxGain.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);
            wrench.prop.setDoppler(dopplerMultiplier(wrench.distance));
            if (now >= wrench.nextCycleAt) {
                scheduleWrenchCycle(wrench.nextCycleAt);
            }
        }

        // Wrench pickup chime — three band-limited saw sweeps with staggered starts,
        // each starting and ending 15% higher than the last. The sequence rises by
        // ~32% across the three sweeps, which lands the perceived interval near a
        // major third — bright but not jarring. Each saw is band-limited by a
        // lowpass at 1.5× its top frequency so the high harmonics that creep in
        // at the sweep peak don't dominate the sound. A triangle one octave below
        // each saw at -6.02 dB (half amplitude) adds body without muddying the top.
        function playWrenchPickup() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const baseStart = 380;
            const baseEnd = 1760;
            const sweepDur = 0.25;
            const attack = 0.030;
            const stagger = 0.080;
            const sawPeakDb = -10;
            const subPeakDb = sawPeakDb - 6.02;

            for (let i = 0; i < 3; i++) {
                const mul = Math.pow(1.15, i);
                const startHz = baseStart * mul;
                const endHz = baseEnd * mul;
                const t0 = now + i * stagger;
                const t1 = t0 + sweepDur;

                const lp = ac.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = endHz * 1.5;
                lp.Q.value = 0.7;

                const sawGain = ac.createGain();
                sawGain.gain.setValueAtTime(0, t0);
                sawGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(sawPeakDb), t0 + attack);
                sawGain.gain.linearRampToValueAtTime(0, t1);

                const saw = ac.createOscillator();
                saw.type = 'sawtooth';
                saw.frequency.setValueAtTime(startHz, t0);
                saw.frequency.exponentialRampToValueAtTime(endHz, t1);
                saw.connect(lp).connect(sawGain).connect(dest);
                sawGain.connect(reverb.send);
                saw.start(t0);
                saw.stop(t1 + 0.02);

                const subGain = ac.createGain();
                subGain.gain.setValueAtTime(0, t0);
                subGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(subPeakDb), t0 + attack);
                subGain.gain.linearRampToValueAtTime(0, t1);

                const sub = ac.createOscillator();
                sub.type = 'triangle';
                sub.frequency.setValueAtTime(startHz / 2, t0);
                sub.frequency.exponentialRampToValueAtTime(endHz / 2, t1);
                sub.connect(subGain).connect(dest);
                subGain.connect(reverb.send);
                sub.start(t0);
                sub.stop(t1 + 0.02);
            }
        }

        // Full-health wrench pickup — same three rising saw sweeps as the normal
        // chime, but the final sweep reverses into a downward glide and a filtered
        // noise "fizzle" so the pickup reads as "nothing to heal, dropped on the
        // floor" rather than a triumphant collect.
        function playWrenchPickupFull() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const baseStart = 380;
            const baseEnd = 1760;
            const sweepDur = 0.25;
            const attack = 0.030;
            const stagger = 0.080;
            const sawPeakDb = -10;
            const subPeakDb = sawPeakDb - 6.02;

            for (let i = 0; i < 3; i++) {
                const mul = Math.pow(1.15, i);
                const startHz = baseStart * mul;
                const endHz = baseEnd * mul;
                const t0 = now + i * stagger;
                const t1 = t0 + sweepDur;

                const lp = ac.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = endHz * 1.5;
                lp.Q.value = 0.7;

                const sawGain = ac.createGain();
                sawGain.gain.setValueAtTime(0, t0);
                sawGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(sawPeakDb), t0 + attack);
                sawGain.gain.linearRampToValueAtTime(0, t1);

                const saw = ac.createOscillator();
                saw.type = 'sawtooth';
                saw.frequency.setValueAtTime(startHz, t0);
                saw.frequency.exponentialRampToValueAtTime(endHz, t1);
                saw.connect(lp).connect(sawGain).connect(dest);
                sawGain.connect(reverb.send);
                saw.start(t0);
                saw.stop(t1 + 0.02);

                const subGain = ac.createGain();
                subGain.gain.setValueAtTime(0, t0);
                subGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(subPeakDb), t0 + attack);
                subGain.gain.linearRampToValueAtTime(0, t1);

                const sub = ac.createOscillator();
                sub.type = 'triangle';
                sub.frequency.setValueAtTime(startHz / 2, t0);
                sub.frequency.exponentialRampToValueAtTime(endHz / 2, t1);
                sub.connect(subGain).connect(dest);
                subGain.connect(reverb.send);
                sub.start(t0);
                sub.stop(t1 + 0.02);
            }

            // Drop tail — a saw that glides down from the top of the last sweep,
            // then a short band-limited noise burst that fizzles out under it.
            const topMul = Math.pow(1.15, 2);
            const dropStart = now + 2 * stagger + sweepDur;
            const dropDur = 0.34;
            const dropEnd = dropStart + dropDur;
            const dropFromHz = baseEnd * topMul;
            const dropToHz = baseStart * 0.45;

            const dropLp = ac.createBiquadFilter();
            dropLp.type = 'lowpass';
            dropLp.frequency.setValueAtTime(dropFromHz * 1.5, dropStart);
            dropLp.frequency.exponentialRampToValueAtTime(Math.max(120, dropToHz * 1.5), dropEnd);
            dropLp.Q.value = 0.7;

            const dropGain = ac.createGain();
            dropGain.gain.setValueAtTime(0, dropStart);
            dropGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(sawPeakDb), dropStart + attack);
            dropGain.gain.exponentialRampToValueAtTime(syngen.fn.fromDb(sawPeakDb - 40), dropEnd);

            const drop = ac.createOscillator();
            drop.type = 'sawtooth';
            drop.frequency.setValueAtTime(dropFromHz, dropStart);
            drop.frequency.exponentialRampToValueAtTime(dropToHz, dropEnd);
            drop.connect(dropLp).connect(dropGain).connect(dest);
            dropGain.connect(reverb.send);
            drop.start(dropStart);
            drop.stop(dropEnd + 0.02);

            // Fizzle — white noise through a falling bandpass that thins to nothing.
            const fizzStart = dropStart + 0.06;
            const fizzDur = 0.32;
            const fizzEnd = fizzStart + fizzDur;
            const noise = ac.createBufferSource();
            noise.buffer = makeWhiteNoiseBuffer();
            noise.loop = true;

            const fizzBp = ac.createBiquadFilter();
            fizzBp.type = 'bandpass';
            fizzBp.frequency.setValueAtTime(2400, fizzStart);
            fizzBp.frequency.exponentialRampToValueAtTime(300, fizzEnd);
            fizzBp.Q.value = 1.2;

            const fizzGain = ac.createGain();
            fizzGain.gain.setValueAtTime(0, fizzStart);
            fizzGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(sawPeakDb - 4), fizzStart + 0.02);
            fizzGain.gain.exponentialRampToValueAtTime(syngen.fn.fromDb(sawPeakDb - 48), fizzEnd);

            noise.connect(fizzBp).connect(fizzGain).connect(dest);
            fizzGain.connect(reverb.send);
            noise.start(fizzStart);
            noise.stop(fizzEnd + 0.02);
        }

        // Gas can cadence is governed by the world generator's gas-can slots.
        // A picked-up can during rocket extends rocket time (handled in loop.js)
        // instead of refueling.

        function spawnGasCan(laneArg, distArg) {
            gasCan.lane = laneArg !== undefined ? laneArg : Math.floor(rand() * 3);
            gasCan.distance = distArg !== undefined ? distArg : 100;
            gasCan.active = true;
            gasCan.consumed = false;
            gasCan.amount = GAS_CAN_FILL_MIN + rand() * (GAS_CAN_FILL_MAX - GAS_CAN_FILL_MIN);
            gasCan.prop = makeGasCanSound({
                x: gasCan.distance / FORWARD_SCALE,
                y: (smoothedLane - gasCan.lane) * LANE_SPACING,
            });
            gasCan.nextCycleAt = syngen.time();
            const positionWord = gasCan.lane === lane
                ? "ahead in your lane"
                : (gasCan.lane < lane ? "ahead on your left" : "ahead on your right");
            announce(`Gas can ${positionWord}.`, {category: 'items'});
        }

        function clearGasCan() {
            if (gasCan.prop) {
                gasCan.prop.destroy();
                gasCan.prop = null;
            }
            gasCan.active = false;
            gasCan.consumed = false;
        }

        function updateGasCanAudio() {
            if (!gasCan.active || !gasCan.prop) return;
            gasCan.prop.setVector({
                x: gasCan.distance / FORWARD_SCALE,
                y: (smoothedLane - gasCan.lane) * LANE_SPACING,
            });
            const proximity = Math.max(0, 1 - Math.abs(gasCan.distance) / 100);
            const gainDb = GAS_CAN_GAIN_MIN_DB + (GAS_CAN_GAIN_MAX_DB - GAS_CAN_GAIN_MIN_DB) * proximity;
            const now = syngen.time();
            gasCan.prop.proxGain.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);
            gasCan.prop.setDoppler(dopplerMultiplier(gasCan.distance));
            if (now >= gasCan.nextCycleAt) {
                scheduleGasCanCycle(gasCan.nextCycleAt);
            }
        }

        // Vague verbal fuel readout — never speak exact numbers.
        function describeFuel() {
            if (fuel >= 0.95) return "Full tank.";
            if (fuel >= 0.70) return "Three quarters full.";
            if (fuel >= 0.40) return "Roughly half full.";
            if (fuel >= 0.25) return "Below half a tank.";
            if (fuel >= 0.12) return "About a quarter of a tank.";
            if (fuel >  0.02) return "Slightly above empty.";
            return "Empty.";
        }

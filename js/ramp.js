        // Ramp prop: a two-note ascending triangle arpeggio (C5 → G5) on a ~0.55s
        // cycle. The rising interval is the "incline" cue. Triangle keeps it warm
        // and easy to localise without competing with the obstacle's FM tone.
        function makeRampSound({y = 0} = {}) {
            const ac = syngen.context();
            const bus = audioChannels.groundProps.createBus('ramp');
            const panner = ac.createStereoPanner();
            panner.connect(bus);

            const proxGain = ac.createGain();
            proxGain.gain.value = syngen.fn.fromDb(RAMP_GAIN_MIN_DB);
            proxGain.connect(panner);

            const oscA = ac.createOscillator();
            oscA.type = 'triangle';
            oscA.frequency.value = 523.25;
            const gA = ac.createGain();
            gA.gain.value = 0;
            oscA.connect(gA).connect(proxGain);
            oscA.start();

            const oscB = ac.createOscillator();
            oscB.type = 'triangle';
            oscB.frequency.value = 783.99;
            const gB = ac.createGain();
            gB.gain.value = 0;
            oscB.connect(gB).connect(proxGain);
            oscB.start();

            // Sub-bass triangle two octaves below the low note for body.
            const sub = ac.createOscillator();
            sub.type = 'triangle';
            sub.frequency.value = 65.41;
            const gSub = ac.createGain();
            gSub.gain.value = 0;
            sub.connect(gSub).connect(proxGain);
            sub.start();

            const RAMP_A_BASE = 523.25;
            const RAMP_B_BASE = 783.99;
            const RAMP_SUB_BASE = 65.41;
            const prop = {
                proxGain, gA: gA.gain, gB: gB.gain, gSub: gSub.gain, panner, bus,
                setVector({y = 0} = {}) {
                    panner.pan.setTargetAtTime(yToPan(y), syngen.time(), 0.05);
                },
                setDoppler(mul) {
                    const now = syngen.time();
                    oscA.frequency.setTargetAtTime(RAMP_A_BASE * mul, now, 0.03);
                    oscB.frequency.setTargetAtTime(RAMP_B_BASE * mul, now, 0.03);
                    sub.frequency.setTargetAtTime(RAMP_SUB_BASE * mul, now, 0.03);
                },
                destroy() {
                    try { oscA.stop(); oscB.stop(); sub.stop(); } catch (e) {}
                    setTimeout(() => {
                        try { panner.disconnect(); } catch (e) {}
                        try { bus.disconnect(); } catch (e) {}
                    }, 60);
                },
            };
            panner.pan.value = yToPan(y);
            return prop;
        }

        // Pulse rate is swept by a slow sine LFO between RAMP_PULSE_MIN_HZ and
        // RAMP_PULSE_MAX_HZ — the rising/falling cadence is itself a cue, and
        // the rate never drops to silence so the ramp stays continuously audible.
        const RAMP_PULSE_MIN_HZ = 12;
        const RAMP_PULSE_MAX_HZ = 40;
        const RAMP_LFO_HZ = 0.3;
        function scheduleRampCycle(t0) {
            if (!ramp.prop) return;
            const peak = syngen.fn.fromDb(-7);
            const subPeak = syngen.fn.fromDb(-6);
            const gA = ramp.prop.gA;
            const gB = ramp.prop.gB;
            const gSub = ramp.prop.gSub;
            gA.cancelScheduledValues(t0);
            gB.cancelScheduledValues(t0);
            gSub.cancelScheduledValues(t0);
            gA.setValueAtTime(0, t0);
            gB.setValueAtTime(0, t0);
            gSub.setValueAtTime(0, t0);

            // Alternate low/high so the rising-interval flavour survives.
            const isLow = (ramp.pulseIndex++ & 1) === 0;
            const g = isLow ? gA : gB;
            const noteDur = 0.08;
            g.linearRampToValueAtTime(peak, t0 + 0.008);
            g.linearRampToValueAtTime(0, t0 + noteDur);
            if (isLow) {
                gSub.linearRampToValueAtTime(subPeak, t0 + 0.008);
                gSub.linearRampToValueAtTime(0, t0 + noteDur);
            }

            const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * RAMP_LFO_HZ * t0);
            const rateHz = RAMP_PULSE_MIN_HZ + (RAMP_PULSE_MAX_HZ - RAMP_PULSE_MIN_HZ) * lfo;
            ramp.nextCycleAt = t0 + 1 / rateHz;
        }

        // Ramp cadence is governed by the world generator's ramp slots.

        function spawnRamp(laneArg, distArg) {
            ramp.lane = laneArg !== undefined ? laneArg : Math.floor(rand() * 3);
            ramp.distance = distArg !== undefined ? distArg : 100;
            ramp.active = true;
            ramp.consumed = false;
            ramp.prop = makeRampSound({
                y: (smoothedLane - ramp.lane) * LANE_SPACING,
            });
            ramp.nextCycleAt = syngen.time();
            ramp.pulseIndex = 0;
            rampEverSpawned = true;

            const positionWord = ramp.lane === lane
                ? "ahead in your lane"
                : (ramp.lane < lane ? "ahead on your left" : "ahead on your right");
            announce(`Ramp ${positionWord}.`, {category: 'items'});
        }

        function clearRamp() {
            if (ramp.prop) {
                ramp.prop.destroy();
                ramp.prop = null;
            }
            ramp.active = false;
            ramp.consumed = false;
        }

        function updateRampAudio() {
            if (!ramp.active || !ramp.prop) return;
            ramp.prop.setVector({
                y: (smoothedLane - ramp.lane) * LANE_SPACING,
            });
            const proximity = Math.max(0, 1 - Math.abs(ramp.distance) / 100);
            const gainDb = RAMP_GAIN_MIN_DB + (RAMP_GAIN_MAX_DB - RAMP_GAIN_MIN_DB) * proximity;
            const now = syngen.time();
            ramp.prop.proxGain.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);
            ramp.prop.setDoppler(dopplerMultiplier(ramp.distance));
            if (now >= ramp.nextCycleAt) scheduleRampCycle(ramp.nextCycleAt);
        }

        // Air coin — uses the rocket coin's makeCoinSound, but on its own state slot
        // and a tighter spawn cadence. No announcements (per spec).
        function spawnAirCoin() {
            airCoin.lane = Math.floor(rand() * 3);
            airCoin.distance = 100;
            airCoin.active = true;
            airCoin.consumed = false;
            airCoin.prop = makeCoinSound({
                y: (smoothedLane - airCoin.lane) * LANE_SPACING,
                channel: 'props',
            });
            airCoin.nextCycleAt = syngen.time();
        }
        function clearAirCoin() {
            if (airCoin.prop) {
                airCoin.prop.destroy();
                airCoin.prop = null;
            }
            airCoin.active = false;
            airCoin.consumed = false;
        }
        function scheduleNextAirCoinSpawn() {
            airCoin.nextSpawnAt = syngen.time()
                + AIR_COIN_GAP_MIN + rand() * (AIR_COIN_GAP_MAX - AIR_COIN_GAP_MIN);
        }
        function updateAirCoinAudio() {
            if (!airCoin.active || !airCoin.prop) return;
            airCoin.prop.setVector({
                y: (smoothedLane - airCoin.lane) * LANE_SPACING,
            });
            const proximity = Math.max(0, 1 - Math.abs(airCoin.distance) / 100);
            const gainDb = -19 + 16 * proximity;
            const now = syngen.time();
            airCoin.prop.proxGain.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);
            airCoin.prop.setDoppler(dopplerMultiplier(airCoin.distance));
            if (now >= airCoin.nextCycleAt) scheduleCoinCycle(airCoin.nextCycleAt, airCoin);
        }

        // Quick rising saw cue — plays when the player hits a ramp to underscore the
        // engine rev (which happens via currentRpm() override during the rev window).
        function playRampLaunchCue() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const dur = 0.35;
            const saw = ac.createOscillator();
            saw.type = 'sawtooth';
            saw.frequency.setValueAtTime(220, now);
            saw.frequency.exponentialRampToValueAtTime(1100, now + dur);
            const g = ac.createGain();
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(syngen.fn.fromDb(-10), now + 0.02);
            g.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + dur);
            saw.connect(g).connect(dest);
            g.connect(reverb.send);
            saw.start(now);
            saw.stop(now + dur + 0.02);
        }

        // Landing impact — short low-filtered noise thud + sub thump. No damage cue.
        function playLandingImpact() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const noiseDur = 0.18;
            const thumpDur = 0.22;

            const src = ac.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            const lp = ac.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.setValueAtTime(900, now);
            lp.frequency.exponentialRampToValueAtTime(150, now + noiseDur);
            const ng = ac.createGain();
            ng.gain.setValueAtTime(0, now);
            ng.gain.linearRampToValueAtTime(0.55, now + 0.005);
            ng.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + noiseDur);
            src.connect(lp).connect(ng).connect(dest);
            ng.connect(reverb.send);
            src.start(now);
            src.stop(now + noiseDur + 0.02);

            const sub = ac.createOscillator();
            sub.type = 'sine';
            sub.frequency.setValueAtTime(120, now);
            sub.frequency.exponentialRampToValueAtTime(55, now + thumpDur);
            const sg = ac.createGain();
            sg.gain.setValueAtTime(0, now);
            sg.gain.linearRampToValueAtTime(syngen.fn.fromDb(-6), now + 0.008);
            sg.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + thumpDur);
            sub.connect(sg).connect(dest);
            sg.connect(reverb.send);
            sub.start(now);
            sub.stop(now + thumpDur + 0.02);
        }

        // Compute the airtime a ramp hit at the given speed would produce.
        // Linear ramp 30 → 150 mph maps to 0 → 15 seconds.
        function rampAirtimeForSpeed(v) {
            if (v < RAMP_MIN_SPEED) return 0;
            const t = Math.min(1, (v - RAMP_MIN_SPEED) / (RAMP_MAX_AIRTIME_SPEED - RAMP_MIN_SPEED));
            return RAMP_MAX_AIRTIME * t;
        }

        function startJump(airtime) {
            const now = syngen.time();
            jumping = true;
            jumpStartedAt = now;
            jumpEndsAt = now + airtime;
            playRampLaunchCue();
            rumble.pulse(0, 1.0, 0.10);
            scheduleNextAirCoinSpawn();
            announce(`Ramp! ${airtime.toFixed(1)} second jump.`, {category: 'items'});
        }

        // Ground-prop occlusion while airborne. Sweeps the groundProps channel's
        // lowpass cutoff down at takeoff, holds at peak height, and sweeps back
        // up on landing — same sin(p*PI) curve the visual lift uses, so what you
        // hear matches what the canvas shows. ~22 kHz is effectively bypass.
        const GROUND_OCCLUSION_OPEN_HZ = 22050;
        const GROUND_OCCLUSION_MUFFLED_HZ = 140;
        // At peak lift the ground channel is also ducked to ~-30 dB on top of
        // the lowpass — together they take ground props down to "barely there"
        // so the player can't audibly identify what's under the car.
        const GROUND_OCCLUSION_DUCK_DB = -30;
        function updateGroundOcclusion() {
            const channel = audioChannels.groundProps;
            const filter = channel.filter;
            if (!filter) return;
            let cutoff = GROUND_OCCLUSION_OPEN_HZ;
            let gain = channel.baseGain;
            if (jumping) {
                const total = jumpEndsAt - jumpStartedAt;
                const p = total > 0
                    ? Math.min(1, Math.max(0, (syngen.time() - jumpStartedAt) / total))
                    : 1;
                const lift = Math.sin(p * Math.PI);
                cutoff = GROUND_OCCLUSION_OPEN_HZ
                    * Math.pow(GROUND_OCCLUSION_MUFFLED_HZ / GROUND_OCCLUSION_OPEN_HZ, lift);
                gain = channel.baseGain * syngen.fn.fromDb(GROUND_OCCLUSION_DUCK_DB * lift);
            }
            const now = syngen.time();
            filter.frequency.setTargetAtTime(cutoff, now, 0.05);
            channel.output.gain.setTargetAtTime(gain, now, 0.05);
        }

        function endJump() {
            jumping = false;
            playLandingImpact();
            rumble.pulse(1.0, 0, 0.18);
            clearAirCoin();
            // Capture the gap to targetSpeed at touchdown so the engine-load
            // recovery in updateEngineAudio can normalise its envelope against it.
            landingDeficit = Math.max(0, targetSpeed - speed);
            landingLoadActive = landingDeficit > 0.5;
            announce(`Landed.`, {category: 'items'});
        }

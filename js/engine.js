        // Build the persistent engine synth (sustained, non-spatial).
        //
        // Voicing: FM with a sawtooth carrier (rich in all harmonics — the basis of any
        // believable engine timbre) and a sub-octave sawtooth modulator. The modulator at
        // 0.5× ratio adds inharmonic grit/rasp without dragging the perceived pitch around,
        // which is what makes the difference between "sawtooth oscillator" and "internal
        // combustion". Lowpass with mild Q gives a warm chest-cavity resonance.
        //
        // Tremolo: a separate LFO is connected directly into the synth's output-gain
        // AudioParam. AudioParam values sum with connected signal sources, so the LFO
        // adds ±depth on top of the constant base gain — i.e. amplitude modulation. This
        // is what produces the audible per-firing "chop" at low RPM.
        function buildEngine() {
            if (engineSynth) return;
            engineSynth = syngen.synth.fm({
                carrierFrequency: ENGINE_FREQ_MIN,
                carrierType: 'sawtooth',
                gain: syngen.fn.fromDb(ENGINE_BASE_DB),
                modDepth: ENGINE_MOD_DEPTH_MIN,
                modFrequency: ENGINE_FREQ_MIN * 0.5,
                modType: 'sawtooth',
            }).filtered({
                frequency: ENGINE_FILTER_MIN,
                Q: 1.2,
                type: 'lowpass',
            }).connect(syngen.mixer.input());

            // Reduced send level — the engine is sustained so even a moderate send
            // level saturates the convolver tail; -18 dB keeps it as ambience.
            // Stored so the tunnel system can ramp it up/down for enclosed acoustics.
            engineReverbSend = reverb.createSend(-18);
            engineSynth.filter.connect(engineReverbSend);
            // Parallel send into the tunnel reverb. Send level is fixed; the
            // master tunnelReverb.wet gain (ramped in tunnel.js) does the
            // crossfade, so this is silent outside tunnels.
            engineTunnelSend = tunnelReverb.createSend(-10);
            engineSynth.filter.connect(engineTunnelSend);

            // Misfire gate — re-route the engine's *final* output through a gain
            // node we can briefly squash to silence to drop individual firing
            // pulses when health is low. Critically, this has to sit AFTER
            // synth.output, because that's the node that holds ENGINE_BASE_DB,
            // the tremolo summing, shift attenuation, and the horn duck. Inserting
            // between filter and output would bypass all of those and hit the
            // mixer at raw unity gain (= clipping). Reverb send stays pre-gate so
            // the room tail rings through misfires — sounds like a blown chamber.
            misfireGate = syngen.context().createGain();
            misfireGate.gain.value = 0.2;
            try { engineSynth.output.disconnect(syngen.mixer.input()); } catch (e) {
                try { engineSynth.output.disconnect(); } catch (e2) {}
            }
            engineSynth.output.connect(misfireGate);
            misfireGate.connect(syngen.mixer.input());

            // Two slow beating LFOs add a wandering micro-pitch drift. Their
            // non-integer rate ratio means the combined detuning never repeats on
            // a fixed period, so the reverb tail sounds different each cycle.
            // The modulator drifts at half the carrier's rate to preserve the 0.5×
            // FM ratio under drift.
            const _driftAc = syngen.context();
            const driftLfo1 = _driftAc.createOscillator();
            driftLfo1.type = 'sine';
            driftLfo1.frequency.value = 0.08;
            const driftDepth1c = _driftAc.createGain();
            driftDepth1c.gain.value = 1.5;
            const driftDepth1m = _driftAc.createGain();
            driftDepth1m.gain.value = 0.75;
            driftLfo1.connect(driftDepth1c).connect(engineSynth.param.frequency);
            driftLfo1.connect(driftDepth1m).connect(engineSynth.param.mod.frequency);
            driftLfo1.start();

            const driftLfo2 = _driftAc.createOscillator();
            driftLfo2.type = 'sine';
            driftLfo2.frequency.value = 0.13;
            const driftDepth2c = _driftAc.createGain();
            driftDepth2c.gain.value = 1;
            const driftDepth2m = _driftAc.createGain();
            driftDepth2m.gain.value = 0.5;
            driftLfo2.connect(driftDepth2c).connect(engineSynth.param.frequency);
            driftLfo2.connect(driftDepth2m).connect(engineSynth.param.mod.frequency);
            driftLfo2.start();

            engineTremolo = syngen.synth.lfo({
                frequency: ENGINE_CHOP_FREQ_MIN,
                // Triangle, not sawtooth: a sawtooth LFO has a vertical edge once per cycle,
                // which steps the gain AudioParam instantaneously and produces an audible
                // click at low chop rates (the discontinuity is the click). Triangle gives
                // a sharp-but-continuous slope — still pulse-like, no click.
                type: 'triangle',
                depth: syngen.fn.fromDb(ENGINE_BASE_DB) * ENGINE_CHOP_DEPTH_AT_IDLE,
            });
            engineTremolo.output.connect(engineSynth.param.gain);
        }

        function buildHorn() {
            if (hornNodes) return;
            const ctx = syngen.context();
            const dest = syngen.mixer.input();

            const oscA = ctx.createOscillator();
            oscA.type = 'triangle';
            oscA.frequency.value = HORN_FREQ_LOW;
            const oscB = ctx.createOscillator();
            oscB.type = 'triangle';
            oscB.frequency.value = HORN_FREQ_HIGH;

            // AM: an LFO drives a gain whose constant is 1.0; the LFO output sums
            // into the gain AudioParam, producing 1 ± depth around unity. Sine LFO
            // keeps the modulation smooth so it reads as buzz, not stutter.
            const amGain = ctx.createGain();
            amGain.gain.value = 1 - HORN_AM_DEPTH; // baseline so peaks reach ~1.0
            const lfo = ctx.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = HORN_AM_FREQ;
            const lfoDepth = ctx.createGain();
            lfoDepth.gain.value = HORN_AM_DEPTH;
            lfo.connect(lfoDepth).connect(amGain.gain);

            // Master gain — gates the horn on/off via attack/release ramps.
            const master = ctx.createGain();
            master.gain.value = 0;

            oscA.connect(amGain);
            oscB.connect(amGain);
            amGain.connect(master).connect(dest);

            // Permanent reverb send — keeps the horn audibly in the same space
            // as the engine. Tunnel system ramps this up for enclosed acoustics.
            hornReverbSend = reverb.createSend(HORN_REVERB_OUT_DB);
            master.connect(hornReverbSend);
            // Parallel tunnel-reverb send (see engineTunnelSend above).
            hornTunnelSend = tunnelReverb.createSend(-4);
            master.connect(hornTunnelSend);

            oscA.start();
            oscB.start();
            lfo.start();

            hornNodes = { master };
        }

        function startHorn() {
            if (hornActive) return;
            buildHorn();
            hornActive = true;
            const now = syngen.time();
            const g = hornNodes.master.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            g.linearRampToValueAtTime(syngen.fn.fromDb(HORN_GAIN_DB), now + HORN_ATTACK);
        }

        function stopHorn() {
            if (!hornActive) return;
            hornActive = false;
            const now = syngen.time();
            const g = hornNodes.master.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            g.linearRampToValueAtTime(0, now + HORN_RELEASE);
        }

        // Near-miss arpeggio: Eb major pentatonic starting at Eb5, repeated up
        // a perfect fourth three times (Ab5, Db6, Gb6). Every other note of the
        // original 20-note run is dropped and the survivors stretched to 40 ms,
        // preserving the 400 ms total length.
        function playNearMiss() {
            const ctx = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const noteLen = 0.040;
            const groups = [
                [622.25,  698.46,  784.00,  932.33, 1046.50],  // Eb5 pentatonic
                [830.61,  932.33, 1046.50, 1244.51, 1396.91],  // Ab5 pentatonic
                [1108.73, 1244.51, 1396.91, 1661.22, 1864.66], // Db6 pentatonic
                [1479.98, 1661.22, 1864.66, 2217.46, 2489.02], // Gb6 pentatonic
            ];
            const allNotes = [].concat(...groups);
            const notes = allNotes.filter((_, idx) => idx % 2 === 0);
            const totalNotes = notes.length;

            // Master gain fades out the upper half to tame the high frequencies.
            const master = ctx.createGain();
            master.gain.setValueAtTime(1.0, now);
            master.gain.setValueAtTime(1.0, now + (totalNotes / 2) * noteLen);
            master.gain.linearRampToValueAtTime(0.2, now + totalNotes * noteLen);
            master.connect(dest);

            notes.forEach((freq, i) => {
                const t = now + i * noteLen;
                const osc = ctx.createOscillator();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                const g = ctx.createGain();
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(syngen.fn.fromDb(-9.5), t + 0.002);
                g.gain.setValueAtTime(syngen.fn.fromDb(-9.5), t + noteLen - 0.003);
                g.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, t + noteLen + 0.003);
                osc.connect(g).connect(master);
                osc.start(t);
                osc.stop(t + noteLen + 0.004);
            });
        }

        // One-shot non-spatial cue (lane change, crash, pass).
        function playCue(frequency, duration, type = 'sine', gainDb = -12) {
            const now = syngen.time();
            const synth = syngen.synth.simple({
                frequency,
                gain: syngen.fn.fromDb(gainDb),
                type,
            }).connect(syngen.mixer.input());
            synth.param.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + duration);
            synth.stop(now + duration);
        }

        // Lane-change cue. An FM voice whose mod depth collapses over the first
        // ~40 ms, so the attack rings with metallic sidebands (a "click") and
        // then settles into a clean tone — this transient cuts through a phone
        // speaker far better than the plain playCue sine did. Duration is ~1.5x
        // the old 0.15 s cue so it's easier to register on mobile.
        function playLaneChangeCue(frequency) {
            const now = syngen.time();
            const duration = 0.22;
            const synth = syngen.synth.fm({
                carrierFrequency: frequency,
                carrierType: 'triangle',
                gain: syngen.fn.fromDb(-12),
                modDepth: frequency * 2.5,
                modFrequency: frequency * 3.1,   // non-integer ratio → inharmonic click
                modType: 'square',
            }).connect(syngen.mixer.input());
            // Mod depth decays fast: sidebands sound only during the attack.
            synth.param.mod.depth.setValueAtTime(frequency * 2.5, now);
            synth.param.mod.depth.exponentialRampToValueAtTime(Math.max(1, frequency * 0.05), now + 0.04);
            synth.param.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + duration);
            synth.stop(now + duration);
        }

        function playThrottleClick(t) {
            const ctx = syngen.context();
            const now = syngen.time();
            const dest = syngen.mixer.input();
            const freq = THROTTLE_CLICK_PITCH_MIN + (THROTTLE_CLICK_PITCH_MAX - THROTTLE_CLICK_PITCH_MIN) * t;

            // Square ping — defined pitch with the high harmonics that cut through.
            const osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.value = freq;
            const oscGain = ctx.createGain();
            oscGain.gain.setValueAtTime(0, now);
            oscGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(-15), now + 0.001);
            oscGain.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + 0.022);
            osc.connect(oscGain).connect(dest);
            osc.start(now);
            osc.stop(now + 0.025);

            // Sub-octave sine — adds body so the click reads as a "tock" rather than
            // a brittle tick. Longer decay than the square so the low tail rounds out
            // the attack instead of fighting it.
            const sub = ctx.createOscillator();
            sub.type = 'sine';
            sub.frequency.value = freq / 2;
            const subGain = ctx.createGain();
            subGain.gain.setValueAtTime(0, now);
            subGain.gain.linearRampToValueAtTime(syngen.fn.fromDb(-9), now + 0.002);
            subGain.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + 0.055);
            sub.connect(subGain).connect(dest);
            sub.start(now);
            sub.stop(now + 0.06);

            // Noise transient highpassed at 1500 Hz — keeps the mid presence that
            // a 3 kHz cutoff was stripping out, while still leaving low-end clean.
            const src = ctx.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 1500;
            const ng = ctx.createGain();
            ng.gain.setValueAtTime(0, now);
            ng.gain.linearRampToValueAtTime(syngen.fn.fromDb(-17), now + 0.001);
            ng.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + 0.014);
            src.connect(hp).connect(ng).connect(dest);
            src.start(now);
            src.stop(now + 0.02);
        }

        function currentThrottleBucket() {
            return Math.max(0, Math.min(THROTTLE_BUCKET_MAX, Math.floor(targetSpeed / THROTTLE_BUCKET_SIZE)));
        }

        function maybeFireThrottleClick() {
            const bucket = currentThrottleBucket();
            if (bucket !== lastThrottleBucket) {
                playThrottleClick(bucket / THROTTLE_BUCKET_MAX);
                lastThrottleBucket = bucket;
            }
        }

        // Returns a frequency multiplier drawn from ±OBSTACLE_PITCH_MAX_SEMITONES,
        // scaled by the current difficulty tier so variance is zero before 10 K and
        // reaches its maximum at tier 10 (100 K+).
        function obstaclePitchMultiplier() {
            const tier = difficultyTier();
            if (tier === 0) return 1.0;
            const maxSemitones = OBSTACLE_PITCH_MAX_SEMITONES * tier / 10;
            const semitones = (rand() * 2 - 1) * maxSemitones;
            return Math.pow(2, semitones / 12);
        }

        function spawnObstacle(laneArg, distArg) {
            obstacle.lane = laneArg !== undefined ? laneArg : Math.floor(rand() * 3);
            obstacle.distance = distArg !== undefined ? distArg : 100;
            obstacle.active = true;
            obstacle.passed = false;
            obstacle.pitchMul = obstaclePitchMultiplier();
            obstacle.minSameLaneDistance = obstacle.lane === lane ? obstacle.distance : Infinity;

            const positionWord = obstacle.lane === lane
                ? "ahead in your lane"
                : (obstacle.lane < lane ? "ahead on your left" : "ahead on your right");
            announce(`Obstacle detected ${positionWord}!`, {category: 'items'});

            obstacle.prop = makeObstacleSound({
                x: obstacle.distance / FORWARD_SCALE,
                y: (smoothedLane - obstacle.lane) * LANE_SPACING,
            });
        }

        function clearObstacle() {
            if (obstacle.prop) {
                obstacle.prop.destroy();
                obstacle.prop = null;
            }
            obstacle.active = false;
            obstacle.passed = false;
            rumble.clearSource('obstacle');
        }

        // Update obstacle spatial position, gain, and filter cutoff each frame.
        // Proximity is computed from |distance| so it ramps up as the obstacle approaches
        // and back down as it falls behind — giving the "approach + pass" arc.
        function updateObstacleAudio() {
            if (!obstacle.active || !obstacle.prop) return;

            obstacle.prop.setVector({
                x: obstacle.distance / FORWARD_SCALE,
                y: (smoothedLane - obstacle.lane) * LANE_SPACING,
            });

            // 0 when far (|distance| ≥ 100), 1 at closest approach (distance == 0).
            const proximity = Math.max(0, 1 - Math.abs(obstacle.distance) / 100);

            // Right-side rumble grows with proximity, falls off as the obstacle
            // recedes behind. Cleared in clearObstacle so it stops at despawn.
            // Suppressed while airborne (obstacles are ground-level) or when the
            // player is two lanes away (out of any plausible collision path).
            const laneDelta = Math.abs(obstacle.lane - lane);
            if (jumping || laneDelta >= 2) {
                rumble.clearSource('obstacle');
            } else {
                rumble.setSource('obstacle', 0, proximity * 0.9, laneDelta === 0);
            }

            const now = syngen.time();
            // Filter cutoff swept exponentially in Hz on prox^0.4 so it opens early
            // and audibly during the approach. Exponent <0.5 biases more opening into
            // the first half of the approach to match when a sighted player first sees
            // the obstacle on the canvas.
            const filterCurve = Math.pow(proximity, 0.4);
            const cutoff = OBSTACLE_FILTER_MIN * Math.pow(
                OBSTACLE_FILTER_MAX / OBSTACLE_FILTER_MIN,
                filterCurve
            );
            obstacle.prop.synth.filter.frequency.setTargetAtTime(cutoff, now, 0.05);

            // Gain envelope likewise front-loaded — concave curve gets the obstacle up
            // to a usable level fast, then eases the rest of the way to its peak.
            const gainCurve = Math.pow(proximity, 0.55);
            const gainDb = OBSTACLE_GAIN_MIN_DB + (OBSTACLE_GAIN_MAX_DB - OBSTACLE_GAIN_MIN_DB) * gainCurve;
            obstacle.prop.synth.param.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);

            // Manual forward-axis Doppler (see DOPPLER_EFFECTIVE_C comment above).
            // Carrier and modulator move together to preserve FM timbre.
            const dopplerMul = dopplerMultiplier(obstacle.distance);
            const carrierHz = OBSTACLE_CARRIER_HZ * obstacle.pitchMul * dopplerMul;
            obstacle.prop.synth.param.frequency.setTargetAtTime(carrierHz, now, 0.03);
            obstacle.prop.synth.param.mod.frequency.setTargetAtTime(carrierHz * 1.5, now, 0.03);
        }

        // ── Cluster / second obstacle ──────────────────────────────────────────
        // Mirrors spawnObstacle / clearObstacle / updateObstacleAudio exactly,
        // but operates on the obstacle2 record. Used only by 'clusterPartner'
        // world events — never spawned by the primary slot path.

        function spawnObstacle2(laneArg, distArg, isSideBySide) {
            obstacle2.lane = laneArg !== undefined ? laneArg : Math.floor(rand() * 3);
            obstacle2.distance = distArg !== undefined ? distArg : 100;
            obstacle2.active = true;
            obstacle2.passed = false;
            obstacle2.pitchMul = obstaclePitchMultiplier();
            obstacle2.minSameLaneDistance = obstacle2.lane === lane ? obstacle2.distance : Infinity;

            const positionWord = obstacle2.lane === lane
                ? 'ahead in your lane'
                : (obstacle2.lane < lane ? 'ahead on your left' : 'ahead on your right');
            if (isSideBySide) {
                announce(`Second obstacle ${positionWord}!`, {category: 'items'});
            } else {
                announce(`Slalom! Obstacle ${positionWord}!`, {category: 'items'});
            }

            obstacle2.prop = makeObstacleSound({
                x: obstacle2.distance / FORWARD_SCALE,
                y: (smoothedLane - obstacle2.lane) * LANE_SPACING,
            });
        }

        function clearObstacle2() {
            if (obstacle2.prop) {
                obstacle2.prop.destroy();
                obstacle2.prop = null;
            }
            obstacle2.active = false;
            obstacle2.passed = false;
            rumble.clearSource('obstacle2');
        }

        function updateObstacleAudio2() {
            if (!obstacle2.active || !obstacle2.prop) return;

            obstacle2.prop.setVector({
                x: obstacle2.distance / FORWARD_SCALE,
                y: (smoothedLane - obstacle2.lane) * LANE_SPACING,
            });

            const proximity = Math.max(0, 1 - Math.abs(obstacle2.distance) / 100);

            const laneDelta = Math.abs(obstacle2.lane - lane);
            if (jumping || laneDelta >= 2) {
                rumble.clearSource('obstacle2');
            } else {
                rumble.setSource('obstacle2', 0, proximity * 0.9, laneDelta === 0);
            }

            const now = syngen.time();
            const filterCurve = Math.pow(proximity, 0.4);
            const cutoff = OBSTACLE_FILTER_MIN * Math.pow(
                OBSTACLE_FILTER_MAX / OBSTACLE_FILTER_MIN,
                filterCurve
            );
            obstacle2.prop.synth.filter.frequency.setTargetAtTime(cutoff, now, 0.05);

            const gainCurve = Math.pow(proximity, 0.55);
            const gainDb = OBSTACLE_GAIN_MIN_DB + (OBSTACLE_GAIN_MAX_DB - OBSTACLE_GAIN_MIN_DB) * gainCurve;
            obstacle2.prop.synth.param.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);

            const dopplerMul = dopplerMultiplier(obstacle2.distance);
            const carrierHz = OBSTACLE_CARRIER_HZ * obstacle2.pitchMul * dopplerMul;
            obstacle2.prop.synth.param.frequency.setTargetAtTime(carrierHz, now, 0.03);
            obstacle2.prop.synth.param.mod.frequency.setTargetAtTime(carrierHz * 1.5, now, 0.03);
        }

        // Drop the engine voice for one firing cycle by squashing the misfire
        // gate to near-silence, holding for ~50–140 ms, then ramping back up.
        // Called from tickEngineDamage; also exposed so cluster scheduling can
        // queue multiple drop-outs in quick succession.
        function triggerMisfire() {
            if (!misfireGate) return;
            const now = syngen.time();
            const g = misfireGate.gain;
            const dropDur = 0.004;
            const holdDur = 0.05 + Math.random() * 0.09;
            const recoverDur = 0.02 + Math.random() * 0.02;
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            g.linearRampToValueAtTime(0.45, now + dropDur);
            g.setValueAtTime(0.45, now + dropDur + holdDur);
            g.linearRampToValueAtTime(1.0, now + dropDur + holdDur + recoverDur);
            // Inject tonal disruption — decayed per-frame in updateEngineAudio as extra
            // FM mod depth. The engine dips in level but keeps the rasp of partial firing.
            misfireTimbre = 1;
        }

        // Pop/bang. Bandpassed noise burst centred in the upper-mid (the "crack")
        // plus a downward-swept low sine (the "thump"). Routed to default channel
        // + reverb send so each shot reads as physical and roomy.
        function playBackfire(intensity) {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const dur = 0.12 + intensity * 0.18;

            const src = ac.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            const bp = ac.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.setValueAtTime(700 + Math.random() * 800, now);
            bp.frequency.exponentialRampToValueAtTime(180, now + dur);
            bp.Q.value = 1.6;
            const ng = ac.createGain();
            ng.gain.setValueAtTime(0, now);
            ng.gain.linearRampToValueAtTime(0.55 + intensity * 0.4, now + 0.003);
            ng.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + dur);
            src.connect(bp).connect(ng).connect(dest);
            ng.connect(reverb.send);
            src.start(now);
            src.stop(now + dur + 0.02);

            const sub = ac.createOscillator();
            sub.type = 'sine';
            sub.frequency.setValueAtTime(140, now);
            sub.frequency.exponentialRampToValueAtTime(45, now + dur);
            const sg = ac.createGain();
            sg.gain.setValueAtTime(0, now);
            sg.gain.linearRampToValueAtTime(0.45 + intensity * 0.4, now + 0.005);
            sg.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + dur);
            sub.connect(sg).connect(dest);
            sub.start(now);
            sub.stop(now + dur + 0.02);
        }

        // Cancel any misfire/backfire bursts still queued from a damaged run and
        // clear the residual misfire grit envelope. Called on restart so stray
        // timers can't fire a misfire/backfire into a fresh, full-health engine.
        function clearEngineDamageTimers() {
            for (let i = 0; i < pendingEngineDamageTimers.length; i++) {
                clearTimeout(pendingEngineDamageTimers[i]);
            }
            pendingEngineDamageTimers.length = 0;
            misfireTimbre = 0;
        }

        // Per-frame scheduler: at low health, fire misfires + backfires on
        // independent random timers. Both can come single or in clusters. A
        // backfire also kicks off a brief "engine can't pull" window that
        // suppresses accel and saps speed (see loop.js).
        function tickEngineDamage(/* delta */) {
            const now = syngen.time();

            if (health < HEALTH_MISFIRE_GATE) {
                if (nextMisfireAt === 0) nextMisfireAt = now + 0.5 + Math.random();
                if (now >= nextMisfireAt) {
                    const intensity = Math.min(1, (HEALTH_MISFIRE_GATE - health) / HEALTH_MISFIRE_GATE);
                    const exaggerated = health < HEALTH_CRITICAL_GATE;
                    const cluster = (Math.random() < (exaggerated ? 0.55 : 0.35))
                        ? 1 + Math.floor(Math.random() * (exaggerated ? 4 : 3))
                        : 1;
                    for (let i = 0; i < cluster; i++) {
                        pendingEngineDamageTimers.push(setTimeout(triggerMisfire, i * (35 + Math.random() * 55)));
                    }
                    const minGap = Math.max(0.2, 1.6 - intensity * 1.2);
                    const maxGap = Math.max(0.5, 3.5 - intensity * 2.5);
                    nextMisfireAt = now + minGap + Math.random() * (maxGap - minGap);
                }
            } else {
                nextMisfireAt = 0;
            }

            if (health < HEALTH_BAD_GATE) {
                if (nextBackfireAt === 0) nextBackfireAt = now + 2 + Math.random() * 3;
                if (now >= nextBackfireAt) {
                    const intensity = Math.min(1, (HEALTH_BAD_GATE - health) / HEALTH_BAD_GATE);
                    // Cluster chance and size scale continuously with damage: near 50%
                    // health bangs are always single; near 0% clusters become common.
                    const healthFrac = health / HEALTH_BAD_GATE; // 0 = dead, 1 = at gate
                    const clusterChance = (1 - healthFrac) * 0.55;
                    const maxClusterExtra = Math.max(1, Math.floor((1 - healthFrac) * 4));
                    const cluster = (Math.random() < clusterChance)
                        ? 2 + Math.floor(Math.random() * maxClusterExtra)
                        : 1;
                    for (let i = 0; i < cluster; i++) {
                        const t = i * (0.08 + Math.random() * 0.14);
                        pendingEngineDamageTimers.push(setTimeout(() => playBackfire(intensity), t * 1000));
                    }
                    backfireActiveUntil = now + 0.35 + cluster * 0.18 + intensity * 0.2;
                    // No direct speed deduction — the backfire window simply
                    // gates off powered acceleration in loop.js. Natural decel
                    // still applies if the player lets off the throttle.
                    const minGap = Math.max(1.2, 6 - intensity * 4);
                    const maxGap = Math.max(2.5, 14 - intensity * 9);
                    nextBackfireAt = now + minGap + Math.random() * (maxGap - minGap);
                }
            } else {
                nextBackfireAt = 0;
                backfireActiveUntil = 0;
            }
        }

        function updateEngineAudio() {
            if (!engineSynth) return;
            const now = syngen.time();
            // Pitch, growl, and chop all track *engine RPM*, not road speed. Decoupling
            // these is the whole point of the gearbox sim: at 76 mph in gear 4 the engine
            // sounds calmer than at 75 mph in gear 3, exactly the same way a real auto does.
            const t = Math.max(0, Math.min(1, currentRpm()));

            // Landing-load envelope: after a jump touchdown, speed is below
            // targetSpeed and climbing back. While it climbs we add controlled
            // roughness + a small gain boost so the engine sounds like it's
            // pulling under load — both ease off as speed approaches the target.
            let landingLoad = 0;
            if (landingLoadActive) {
                if (landingDeficit > 0) {
                    landingLoad = Math.max(0, Math.min(1, (targetSpeed - speed) / landingDeficit));
                }
                if (landingLoad <= 0.02) {
                    landingLoadActive = false;
                    landingLoad = 0;
                }
            }
            const rough = Math.min(1, engineRoughness() + landingLoad * 0.35);
            // Random per-frame jitter on carrier + filter, scaled by roughness.
            // setTargetAtTime smooths it; with a short time constant the result
            // reads as audible wobble rather than discrete steps. Math.random
            // (not the seeded RNG) so the wobble doesn't desync spawns.
            const carrierJitter = (Math.random() - 0.5) * 2 * rough * 14;
            const carrier = ENGINE_FREQ_MIN + (ENGINE_FREQ_MAX - ENGINE_FREQ_MIN) * t + carrierJitter;
            const carrierTc = rough > 0 ? 0.04 : 0.1;
            engineSynth.param.frequency.setTargetAtTime(carrier, now, carrierTc);
            engineSynth.param.mod.frequency.setTargetAtTime(carrier * 0.5, now, carrierTc);

            // Modulation depth tracks revs — more FM sidebands at high RPM = sustained growl.
            // Roughness piles extra inharmonic grit on top so a sick engine has
            // audible rasp even at low RPM. misfireTimbre adds a burst of inharmonic grit
            // for the duration of a misfire so it reads as partial-cylinder rasp, not silence.
            if (misfireTimbre > 0) misfireTimbre = Math.max(0, misfireTimbre - 0.14);
            const modDepth = ENGINE_MOD_DEPTH_MIN + (ENGINE_MOD_DEPTH_MAX - ENGINE_MOD_DEPTH_MIN) * t
                + rough * 120 + misfireTimbre * 200;
            engineSynth.param.mod.depth.setTargetAtTime(modDepth, now, carrierTc);

            // .filtered() attaches the BiquadFilter as engineSynth.filter — its AudioParams live on the node itself.
            if (engineSynth.filter) {
                // Sick engines lose top end (fouled plugs / clogged intake), so
                // clamp the cutoff down with roughness, plus a small random wobble.
                const baseCutoff = ENGINE_FILTER_MIN + (ENGINE_FILTER_MAX - ENGINE_FILTER_MIN) * t;
                const filterAtten = 1 - rough * 0.45;
                const filterJitter = 1 + (Math.random() - 0.5) * rough * 0.25;
                const cutoff = Math.max(ENGINE_FILTER_MIN * 0.5, baseCutoff * filterAtten * filterJitter);
                engineSynth.filter.frequency.setTargetAtTime(cutoff, now, carrierTc);
            }

            // Mid-shift gain dip — torque converter slips while the next clutch pack engages,
            // so apparent engine load drops momentarily. Sin(πp) gives a smooth dip-and-restore.
            let shiftAtten = 1;
            if (shifting) {
                const p = Math.min(1, shiftElapsed / SHIFT_DURATION);
                shiftAtten = 1 - SHIFT_ATTENUATION * Math.sin(p * Math.PI);
            }
            const duck = hornActive ? syngen.fn.fromDb(HORN_ENGINE_DUCK_DB) : 1;
            // ~+2.5 dB boost at peak load, tapering to 0 dB as speed reaches the
            // target — perceptually "engine working harder, then settling".
            const loadBoost = syngen.fn.fromDb(landingLoad * 2.5);
            const baseGain = syngen.fn.fromDb(ENGINE_BASE_DB) * shiftAtten * duck * loadBoost;
            engineSynth.param.gain.setTargetAtTime(baseGain, now, 0.05);

            if (engineTremolo) {
                const chopFreq = ENGINE_CHOP_FREQ_MIN + (ENGINE_CHOP_FREQ_MAX - ENGINE_CHOP_FREQ_MIN) * t;
                engineTremolo.param.frequency.setTargetAtTime(chopFreq, now, 0.1);
                // Chop fades with RPM (not road speed) — individual firings only blur once the
                // engine is actually spinning fast, regardless of which gear you're in.
                const fade = Math.max(0, 1 - t / 0.5);
                const depth = baseGain * ENGINE_CHOP_DEPTH_AT_IDLE * fade;
                engineTremolo.param.depth.setTargetAtTime(depth, now, 0.1);
            }
        }

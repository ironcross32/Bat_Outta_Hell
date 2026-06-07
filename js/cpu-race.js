        // ===== CPU opponent + booster race =====
        // Owns the entire challenge subsystem: rotary engine voice, dual-tone
        // E4+G#4 horn, AI behaviour, challenge handshake, fixed-distance race
        // with booster-only world generation, boost ramp/hold/release, and
        // car-on-car collision. World-level booster spawning lives in
        // js/world.js so the perlin generator stays the single source of
        // spawns; everything else lives here.

        function cpuRpmInGear(g, v) {
            return Math.max(CPU_IDLE_RPM,
                Math.min(1.10, v * CPU_GEAR_RATIOS[g - 1] / CPU_RPM_REF));
        }

        // Wider hysteresis (0.78) so the rotary holds each gear longer before
        // downshifting — it really wants to live near redline.
        function cpuDesiredGear(v, currentGear) {
            if (currentGear < 5 && v >= CPU_SHIFT_POINTS_UP[currentGear - 1]) return currentGear + 1;
            if (currentGear > 1 && v < CPU_SHIFT_POINTS_UP[currentGear - 2] * 0.78) return currentGear - 1;
            return currentGear;
        }

        function cpuCurrentRpm() {
            if (!cpuCar.shifting) return cpuRpmInGear(cpuCar.gear, cpuCar.speed);
            const p = Math.min(1, cpuCar.shiftElapsed / CPU_SHIFT_DURATION);
            const smooth = p * p * (3 - 2 * p);
            const toRpm = cpuRpmInGear(cpuCar.shiftToGear, cpuCar.speed);
            return cpuCar.shiftFromRpm + (toRpm - cpuCar.shiftFromRpm) * smooth;
        }

        // Build the CPU's rotary engine voice — same FM topology as the player
        // engine but tuned for rotary character (lighter chop, brighter top,
        // higher carrier swing) and routed through its own spatial chain
        // (gainNode + panner) so proximity and pan track the car position.
        function buildCpuEngine() {
            if (cpuCar.synth) return;
            const ac = syngen.context();
            cpuCar.bus = audioChannels.default.createBus('cpuCarEngine');
            cpuCar.synth = syngen.synth.fm({
                carrierFrequency: CPU_ENGINE_FREQ_MIN,
                carrierType: 'sawtooth',
                gain: syngen.fn.fromDb(CPU_ENGINE_BASE_DB),
                modDepth: CPU_ENGINE_MOD_DEPTH_MIN,
                modFrequency: CPU_ENGINE_FREQ_MIN * 1.5,
                modType: 'triangle',
            }).filtered({
                frequency: CPU_ENGINE_FILTER_MIN,
                Q: 0.9,
                type: 'lowpass',
            });
            cpuCar.panner = ac.createStereoPanner();
            // syngen.synth.fm().filtered() doesn't auto-connect to a destination
            // (the engine.js builder reaches that with an explicit .connect()),
            // so we can route .output straight into the spatial chain.
            cpuCar.synth.output
                .connect(cpuCar.panner)
                .connect(cpuCar.bus);

            // Lighter tremolo than the player — rotaries pulse smoother.
            cpuCar.tremolo = syngen.synth.lfo({
                frequency: CPU_ENGINE_CHOP_FREQ_MIN,
                type: 'triangle',
                depth: syngen.fn.fromDb(CPU_ENGINE_BASE_DB) * CPU_ENGINE_CHOP_DEPTH,
            });
            cpuCar.tremolo.output.connect(cpuCar.synth.param.gain);
        }

        function destroyCpuEngine() {
            if (cpuCar.tremolo) { try { cpuCar.tremolo.stop(); } catch (e) {} cpuCar.tremolo = null; }
            if (cpuCar.synth) { try { cpuCar.synth.stop(); } catch (e) {} cpuCar.synth = null; }
            if (cpuCar.bus) { try { cpuCar.bus.disconnect(); } catch (e) {} cpuCar.bus = null; }
            cpuCar.panner = null;
            if (cpuCar.hornNodes) {
                try { cpuCar.hornNodes.oscA.stop(); } catch (e) {}
                try { cpuCar.hornNodes.oscB.stop(); } catch (e) {}
                try { cpuCar.hornNodes.lfo.stop(); } catch (e) {}
                try { cpuCar.hornNodes.master.disconnect(); } catch (e) {}
                cpuCar.hornNodes = null;
            }
        }

        function updateCpuEngineAudio() {
            if (!cpuCar.active || !cpuCar.synth) return;
            const now = syngen.time();
            const t = Math.max(0, Math.min(1, cpuCurrentRpm()));

            const carrier = CPU_ENGINE_FREQ_MIN + (CPU_ENGINE_FREQ_MAX - CPU_ENGINE_FREQ_MIN) * t;
            cpuCar.synth.param.frequency.setTargetAtTime(carrier, now, 0.08);
            cpuCar.synth.param.mod.frequency.setTargetAtTime(carrier * 1.5, now, 0.08);
            const modDepth = CPU_ENGINE_MOD_DEPTH_MIN + (CPU_ENGINE_MOD_DEPTH_MAX - CPU_ENGINE_MOD_DEPTH_MIN) * t;
            cpuCar.synth.param.mod.depth.setTargetAtTime(modDepth, now, 0.08);
            if (cpuCar.synth.filter) {
                const cutoff = CPU_ENGINE_FILTER_MIN + (CPU_ENGINE_FILTER_MAX - CPU_ENGINE_FILTER_MIN) * t;
                cpuCar.synth.filter.frequency.setTargetAtTime(cutoff, now, 0.08);
            }
            if (cpuCar.tremolo) {
                const chopFreq = CPU_ENGINE_CHOP_FREQ_MIN + (CPU_ENGINE_CHOP_FREQ_MAX - CPU_ENGINE_CHOP_FREQ_MIN) * t;
                cpuCar.tremolo.param.frequency.setTargetAtTime(chopFreq, now, 0.1);
                const fade = Math.max(0, 1 - t / 0.6);
                const depth = syngen.fn.fromDb(CPU_ENGINE_BASE_DB) * CPU_ENGINE_CHOP_DEPTH * fade;
                cpuCar.tremolo.param.depth.setTargetAtTime(depth, now, 0.1);
            }

            // Spatial: gain falls off with distance; lateral lane offset maps
            // to pan via yToPan, matching every other prop in the game.
            // Drive synth.param.gain directly — no intermediate gainNode, so
            // there's only one attenuation stage instead of two stacked ones.
            const d = cpuCar.distance;
            const proximity = Math.max(0, 1 - Math.abs(d) / 200);
            const gainDb = -18 + 15 * proximity;
            cpuCar.synth.param.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.06);

            const y = (smoothedLane - cpuCar.lane) * LANE_SPACING;
            cpuCar.panner.pan.setTargetAtTime(yToPan(y), now, 0.05);
        }

        function buildCpuHorn() {
            if (cpuCar.hornNodes || !cpuCar.bus) return;
            const ac = syngen.context();
            const oscA = ac.createOscillator();
            oscA.type = 'triangle';
            oscA.frequency.value = CPU_HORN_FREQ_LOW;
            const oscB = ac.createOscillator();
            oscB.type = 'triangle';
            oscB.frequency.value = CPU_HORN_FREQ_HIGH;
            const amGain = ac.createGain();
            amGain.gain.value = 1 - CPU_HORN_AM_DEPTH;
            const lfo = ac.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = CPU_HORN_AM_FREQ;
            const lfoDepth = ac.createGain();
            lfoDepth.gain.value = CPU_HORN_AM_DEPTH;
            lfo.connect(lfoDepth).connect(amGain.gain);
            const master = ac.createGain();
            master.gain.value = 0;
            oscA.connect(amGain);
            oscB.connect(amGain);
            // Route through the CPU's panner so the horn pans with the car.
            amGain.connect(master);
            if (cpuCar.panner) {
                master.connect(cpuCar.panner);
            } else {
                master.connect(cpuCar.bus);
            }
            oscA.start();
            oscB.start();
            lfo.start();
            cpuCar.hornNodes = { oscA, oscB, lfo, master };
        }

        function playCpuHorn() {
            buildCpuHorn();
            if (!cpuCar.hornNodes) return;
            const now = syngen.time();
            // Reset to base pitch in case a flyby sweep left oscillators detuned.
            cpuCar.hornNodes.oscA.frequency.cancelScheduledValues(now);
            cpuCar.hornNodes.oscA.frequency.setValueAtTime(CPU_HORN_FREQ_LOW, now);
            cpuCar.hornNodes.oscB.frequency.cancelScheduledValues(now);
            cpuCar.hornNodes.oscB.frequency.setValueAtTime(CPU_HORN_FREQ_HIGH, now);
            const g = cpuCar.hornNodes.master.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(0, now);
            g.linearRampToValueAtTime(syngen.fn.fromDb(CPU_HORN_GAIN_DB), now + 0.02);
            g.setValueAtTime(syngen.fn.fromDb(CPU_HORN_GAIN_DB), now + CPU_HORN_DURATION - 0.08);
            g.linearRampToValueAtTime(0, now + CPU_HORN_DURATION);
        }

        // Doppler-swept horn: fires when the CPU is 25 units behind and holds
        // through +25 units ahead. Duration is computed from the actual closure
        // rate so the pitch crosses the midpoint exactly as the car passes.
        // Gain rises on approach, peaks at the crossing, fades as it recedes.
        function playCpuFlybyHorn() {
            buildCpuHorn();
            if (!cpuCar.hornNodes) return;
            const now = syngen.time();
            // Time to travel the 50-unit window (-25 → +25) at current closure speed.
            const closureUnitsPerSec = Math.max(10, ((cpuCar.speed - speed) / 100) * 90);
            const sweepDur = 50 / closureUnitsPerSec;
            const totalDur = sweepDur + 0.35;
            const { oscA, oscB, master } = cpuCar.hornNodes;
            // Pitch: high (approaching) → low (receding), sweep completes at +25 units.
            oscA.frequency.cancelScheduledValues(now);
            oscA.frequency.setValueAtTime(CPU_HORN_FREQ_LOW * 1.22, now);
            oscA.frequency.exponentialRampToValueAtTime(CPU_HORN_FREQ_LOW * 0.78, now + sweepDur);
            oscB.frequency.cancelScheduledValues(now);
            oscB.frequency.setValueAtTime(CPU_HORN_FREQ_HIGH * 1.22, now);
            oscB.frequency.exponentialRampToValueAtTime(CPU_HORN_FREQ_HIGH * 0.78, now + sweepDur);
            // Gain: rise on approach, peak straddling the crossing, decay as it recedes.
            const g = master.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(0, now);
            g.linearRampToValueAtTime(syngen.fn.fromDb(CPU_HORN_GAIN_DB + 6), now + sweepDur * 0.4);
            g.setValueAtTime(syngen.fn.fromDb(CPU_HORN_GAIN_DB + 6), now + sweepDur * 0.6);
            g.exponentialRampToValueAtTime(syngen.fn.fromDb(CPU_HORN_GAIN_DB - 8), now + totalDur);
            g.linearRampToValueAtTime(0, now + totalDur + 0.08);
        }

        // Tri-tone upward sweep with shared tremolo. Played whenever any car
        // hits a booster — panned to the booster's lane so the player can hear
        // which one was just consumed.
        function playBoosterCue(boosterLaneY) {
            const ac = syngen.context();
            const now = syngen.time();
            const dur = 0.5;
            const baseHz = 260;
            const bus = audioChannels.default.createBus('boosterCue');
            const pan = ac.createStereoPanner();
            pan.pan.value = yToPan(boosterLaneY);
            pan.connect(bus);
            const env = ac.createGain();
            env.gain.setValueAtTime(0, now);
            env.gain.linearRampToValueAtTime(syngen.fn.fromDb(-6), now + 0.12);
            env.gain.setValueAtTime(syngen.fn.fromDb(-6), now + dur - 0.15);
            env.gain.linearRampToValueAtTime(0, now + dur);
            // Shared 7 Hz tremolo for all three voices.
            const am = ac.createGain();
            am.gain.value = 0.65;
            const lfo = ac.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = 7;
            const lfoDepth = ac.createGain();
            lfoDepth.gain.value = 0.35;
            lfo.connect(lfoDepth).connect(am.gain);
            am.connect(env).connect(pan);
            [1.0, 1.25, 1.5].forEach((ratio) => {
                const osc = ac.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(baseHz * ratio, now);
                osc.frequency.exponentialRampToValueAtTime(baseHz * ratio * 3.2, now + dur);
                osc.connect(am);
                osc.start(now);
                osc.stop(now + dur + 0.04);
            });
            lfo.start(now);
            lfo.stop(now + dur + 0.04);
            setTimeout(() => { try { bus.disconnect(); } catch (e) {} }, (dur + 0.2) * 1000);
        }

        // Low bandpassed noise burst + sub-thump — modelled on playBackfire.
        function playBumpCue() {
            const ac = syngen.context();
            const dest = syngen.mixer.input();
            const now = syngen.time();
            const dur = 0.22;
            const src = ac.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            const bp = ac.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.setValueAtTime(380, now);
            bp.frequency.exponentialRampToValueAtTime(110, now + dur);
            bp.Q.value = 1.2;
            const ng = ac.createGain();
            ng.gain.setValueAtTime(0, now);
            ng.gain.linearRampToValueAtTime(0.7, now + 0.005);
            ng.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + dur);
            src.connect(bp).connect(ng).connect(dest);
            src.start(now);
            src.stop(now + dur + 0.02);
            const sub = ac.createOscillator();
            sub.type = 'sine';
            sub.frequency.setValueAtTime(95, now);
            sub.frequency.exponentialRampToValueAtTime(38, now + dur);
            const sg = ac.createGain();
            sg.gain.setValueAtTime(0, now);
            sg.gain.linearRampToValueAtTime(0.65, now + 0.008);
            sg.gain.exponentialRampToValueAtTime(syngen.const.zeroGain, now + dur);
            sub.connect(sg).connect(dest);
            sub.start(now);
            sub.stop(now + dur + 0.02);
        }

        // ===== Booster pickup (world entity) =====
        function spawnBooster(laneArg, distArg) {
            booster.lane = laneArg !== undefined ? laneArg : Math.floor(rand() * 3);
            booster.distance = distArg !== undefined ? distArg : 100;
            booster.active = true;
            booster.consumed = false;
            booster.boostMph = CHALLENGE_BOOSTER_MIN_MPH
                + Math.floor(rand() * (CHALLENGE_BOOSTER_MAX_MPH - CHALLENGE_BOOSTER_MIN_MPH + 1));

            // Lightweight pulsing tonal cue so the player can hear lane + distance.
            const ac = syngen.context();
            booster.bus = audioChannels.props.createBus('booster');
            booster.panner = ac.createStereoPanner();
            booster.panner.pan.value = yToPan((smoothedLane - booster.lane) * LANE_SPACING);
            booster.gainNode = ac.createGain();
            booster.gainNode.gain.value = syngen.fn.fromDb(BOOSTER_GAIN_MIN_DB);
            // Two slightly detuned sawtooths for a chord-y "speed pad" colour.
            const oscA = ac.createOscillator();
            oscA.type = 'sawtooth';
            oscA.frequency.value = 360;
            const oscB = ac.createOscillator();
            oscB.type = 'sawtooth';
            oscB.frequency.value = 540;
            const lp = ac.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 1800;
            lp.Q.value = 0.7;
            oscA.connect(lp);
            oscB.connect(lp);
            lp.connect(booster.gainNode).connect(booster.panner).connect(booster.bus);
            oscA.start();
            oscB.start();
            booster.synth = { oscA, oscB, lp };

            const positionWord = booster.lane === lane
                ? "ahead in your lane"
                : (booster.lane < lane ? "ahead on your left" : "ahead on your right");
            announce(`Booster ${booster.boostMph} ${positionWord}.`, {category: 'items'});
        }

        function clearBooster() {
            if (booster.synth) {
                try { booster.synth.oscA.stop(); } catch (e) {}
                try { booster.synth.oscB.stop(); } catch (e) {}
                booster.synth = null;
            }
            if (booster.bus) {
                const bus = booster.bus;
                setTimeout(() => { try { bus.disconnect(); } catch (e) {} }, 100);
                booster.bus = null;
            }
            booster.panner = null;
            booster.gainNode = null;
            booster.active = false;
            booster.consumed = false;
        }

        function updateBoosterAudio() {
            if (!booster.active || !booster.panner) return;
            const now = syngen.time();
            booster.panner.pan.setTargetAtTime(
                yToPan((smoothedLane - booster.lane) * LANE_SPACING), now, 0.05);
            const proximity = Math.max(0, 1 - Math.abs(booster.distance) / 100);
            const gainDb = BOOSTER_GAIN_MIN_DB
                + (BOOSTER_GAIN_MAX_DB - BOOSTER_GAIN_MIN_DB) * Math.pow(proximity, 0.55);
            booster.gainNode.gain.setTargetAtTime(syngen.fn.fromDb(gainDb), now, 0.05);
        }

        // ===== Booster effect =====
        // Either car can pick up a booster. The boost is additive on top of
        // current speed (capped at 175), ramps for 3 s, holds for 2 s, then
        // releases — the player's targetSpeed becomes whatever the throttle is
        // asking for (or the boosted speed, whichever is higher, during the
        // boost). For the CPU the same logic applies via cpuCar fields.
        function applyBoostToPlayer(boostMph) {
            const now = syngen.time();
            const newTarget = Math.min(CHALLENGE_BOOST_CAP, speed + boostMph);
            // Stack: refresh timers, keep the higher target.
            playerBoost.targetSpeed = Math.max(playerBoost.targetSpeed, newTarget);
            playerBoost.holdUntil = now + CHALLENGE_BOOST_RAMP + CHALLENGE_BOOST_HOLD;
            playerBoost.endsAt = playerBoost.holdUntil;
            playerBoost.active = true;
            announce(`Boost ${boostMph}.`, {category: 'powerups'});
        }

        function applyBoostToCpu(boostMph) {
            const now = syngen.time();
            const newTarget = Math.min(CHALLENGE_BOOST_CAP, cpuCar.speed + boostMph);
            cpuCar.boostTargetSpeed = Math.max(cpuCar.boostTargetSpeed, newTarget);
            cpuCar.boostHoldUntil = now + CHALLENGE_BOOST_RAMP + CHALLENGE_BOOST_HOLD;
            cpuCar.boostEndsAt = cpuCar.boostHoldUntil;
            cpuCar.boostActive = true;
            announce(`Opponent boosted ${boostMph}.`, {category: 'powerups'});
        }

        function updatePlayerBoost() {
            if (!playerBoost.active) return;
            if (syngen.time() >= playerBoost.endsAt) {
                playerBoost.active = false;
                playerBoost.targetSpeed = 0;
            }
        }

        // ===== AI accuracy =====
        // Base 35%, slides up if the player is ahead (gives the AI a chance to
        // catch up), slides down if the player is behind. Capped at 80%.
        function cpuAccuracy() {
            if (!challengeState.active) return CHALLENGE_AI_ACCURACY_MIN;
            const lead = challengeState.playerDistance - challengeState.cpuDistance;
            // Sigmoid-ish on lead/scale, mapped to the [min, max] band.
            const t = 1 / (1 + Math.exp(-lead / CHALLENGE_AI_LEAD_SCALE));
            return CHALLENGE_AI_ACCURACY_MIN
                + (CHALLENGE_AI_ACCURACY_MAX - CHALLENGE_AI_ACCURACY_MIN) * t;
        }

        // ===== Spawn / despawn =====
        function scheduleNextCpuSpawn() {
            nextCpuSpawnAt = syngen.time()
                + CPU_SPAWN_INTERVAL_MIN
                + rand() * (CPU_SPAWN_INTERVAL_MAX - CPU_SPAWN_INTERVAL_MIN);
        }

        function spawnCpu() {
            if (cpuCar.active) return;
            // Pick a lane different from the player's.
            const candidates = [0, 1, 2].filter((l) => l !== lane);
            cpuCar.lane = candidates[Math.floor(rand() * candidates.length)];
            cpuCar.distance = CPU_SPAWN_DISTANCE;
            cpuCar.speed = Math.max(40, speed - 5);
            cpuCar.targetSpeed = CPU_APPROACH_SPEED;
            cpuCar.gear = 1;
            cpuCar.currentRpm = CPU_IDLE_RPM;
            cpuCar.shifting = false;
            cpuCar.laneChangeCooldown = 0;
            cpuCar.phase = 'approaching';
            cpuCar.holdSpeed = 0;
            cpuCar.deceleratedToHoldSpeed = false;
            cpuCar.flybyHornPlayed = false;
            cpuCar.awaitingHonk = false;
            cpuCar.hornAttempts = 0;
            cpuCar.handshakeNextHornAt = 0;
            cpuCar.handshakeExpiresAt = 0;
            cpuCar.boostActive = false;
            cpuCar.boostTargetSpeed = 0;
            cpuCar.boosterTargetLane = null;
            cpuCar.active = true;
            buildCpuEngine();
            announce(`Challenger approaching from behind, ${laneNames[cpuCar.lane].toLowerCase()}.`,
                {category: 'items'});
        }

        function despawnCpu() {
            if (!cpuCar.active && !cpuCar.synth) return;
            cpuCar.active = false;
            cpuCar.awaitingHonk = false;
            cpuCar.boostActive = false;
            destroyCpuEngine();
            scheduleNextCpuSpawn();
        }

        // ===== Challenge handshake + lifecycle =====
        function startChallenge() {
            challengeState.active = true;
            challengeState.startedAt = syngen.time();
            challengeState.playerStartPos = worldPos;
            challengeState.cpuStartPos = worldPos + cpuCar.distance;
            challengeState.playerDistance = 0;
            challengeState.cpuDistance = 0;
            cpuCar.awaitingHonk = false;

            // Wipe the existing horizon so nothing pre-generated bleeds into
            // the booster-only stretch. The next tickWorld() will refill the
            // lookahead window — and once challengeState.active is set,
            // materializeEvent in world.js only spawns boosters.
            clearAllWorldEvents();

            // Confirm-honk cue from the player side too (a quick pair of cues
            // an octave apart so it's obviously distinct from the CPU horn).
            playCue(523, 0.18, 'triangle', -8);
            setTimeout(() => playCue(1047, 0.22, 'triangle', -8), 120);
            announce(`Challenge accepted. First to ${CHALLENGE_DISTANCE} units wins.`);
        }

        function endChallenge(winner) {
            if (!challengeState.active) return;
            challengeState.active = false;
            if (booster.active) clearBooster();
            // Wipe lingering booster-only events so the normal map resumes clean.
            clearAllWorldEvents();
            // Lose-cue: descending pair; win-cue: ascending fourth fanfare.
            if (winner === 'player') {
                playCue(523, 0.2, 'triangle', -7);
                setTimeout(() => playCue(659, 0.2, 'triangle', -7), 140);
                setTimeout(() => playCue(880, 0.35, 'triangle', -7), 280);
                announce(`You won the race!`);
            } else {
                playCue(330, 0.25, 'triangle', -8);
                setTimeout(() => playCue(220, 0.4, 'triangle', -8), 200);
                announce(`Opponent won the race.`);
            }
            // After a challenge the CPU guns it and drives off.
            if (cpuCar.active) {
                cpuCar.awaitingHonk = false;
                cpuCar.phase = 'drivingAway';
            }
        }

        // Called from the horn keydown — only accepts when the CPU is
        // currently in the handshake window.
        function acceptChallenge() {
            if (!cpuCar.active || !cpuCar.awaitingHonk) return false;
            if (challengeState.active) return false;
            // Airborne player can't accept — keeps the handshake grounded.
            if (jumping) return false;
            startChallenge();
            return true;
        }

        // ===== Per-frame CPU update =====
        function updateCpu(delta) {
            if (!cpuCar.active) {
                // if (gameRunning && !challengeState.active && syngen.time() >= nextCpuSpawnAt) {
                //     spawnCpu();
                // }
                return;
            }

            const now = syngen.time();

            // Boost ramp/hold/release for the CPU.
            if (cpuCar.boostActive) {
                if (now >= cpuCar.boostEndsAt) {
                    cpuCar.boostActive = false;
                    cpuCar.boostTargetSpeed = 0;
                }
            }

            // Decide CPU target speed.
            if (challengeState.active) {
                cpuCar.targetSpeed = cpuCar.boostActive
                    ? cpuCar.boostTargetSpeed
                    : CPU_TOP_SPEED;
            } else {
                switch (cpuCar.phase) {
                    case 'approaching':
                    case 'flyby':
                        cpuCar.targetSpeed = CPU_APPROACH_SPEED;
                        break;
                    case 'holding':
                        cpuCar.targetSpeed = cpuCar.holdSpeed;
                        // Once decelerated to the hold speed, open the handshake.
                        if (!cpuCar.deceleratedToHoldSpeed
                                && Math.abs(cpuCar.speed - cpuCar.holdSpeed) <= 3) {
                            cpuCar.deceleratedToHoldSpeed = true;
                            cpuCar.awaitingHonk = true;
                            cpuCar.hornAttempts = 0;
                            cpuCar.handshakeNextHornAt = now;
                            cpuCar.handshakeExpiresAt = now
                                + CPU_HORN_INTERVAL * CPU_HORN_MAX_ATTEMPTS + 1;
                            announce(`Challenger honks. Press space to accept.`,
                                {category: 'items', critical: true});
                        }
                        break;
                    case 'drivingAway':
                        cpuCar.targetSpeed = CPU_APPROACH_SPEED;
                        break;
                }
            }

            // Apply accel/decel using the player's curve shape but CPU constants.
            if (cpuCar.shifting) {
                cpuCar.shiftElapsed += delta;
                if (cpuCar.shiftElapsed >= CPU_SHIFT_DURATION) {
                    cpuCar.shifting = false;
                    cpuCar.gear = cpuCar.shiftToGear;
                }
            } else if (cpuCar.speed !== cpuCar.targetSpeed) {
                if (cpuCar.targetSpeed > cpuCar.speed) {
                    const vInf = cpuCar.boostActive
                        ? CHALLENGE_BOOST_CAP + 10
                        : (cpuCar.phase === 'approaching' || cpuCar.phase === 'flyby'
                            ? CPU_APPROACH_SPEED + 8
                            : CPU_ACCEL_V_INF);
                    const accel = CPU_ACCEL_A0 * Math.max(0, 1 - cpuCar.speed / vInf);
                    cpuCar.speed = Math.min(cpuCar.targetSpeed, cpuCar.speed + accel * delta);
                } else {
                    cpuCar.speed = Math.max(cpuCar.targetSpeed,
                        cpuCar.speed - CPU_DECEL_RATE * delta);
                }
                const ng = cpuDesiredGear(cpuCar.speed, cpuCar.gear);
                if (ng !== cpuCar.gear) {
                    cpuCar.shifting = true;
                    cpuCar.shiftElapsed = 0;
                    cpuCar.shiftFromRpm = cpuRpmInGear(cpuCar.gear, cpuCar.speed);
                    cpuCar.shiftToGear = ng;
                }
            }

            // Advance distance using closure rate vs. player.
            const closure = ((cpuCar.speed - speed) / 100) * 90;
            cpuCar.distance += closure * delta;

            // Horn starts 25 units before the crossing so the Doppler sweep
            // brackets the player's position (-25 → +25).
            if (cpuCar.phase === 'approaching' && !cpuCar.flybyHornPlayed
                    && cpuCar.distance >= -25) {
                cpuCar.flybyHornPlayed = true;
                playCpuFlybyHorn();
            }

            // Phase transition and hold-speed selection at the actual crossing.
            if (cpuCar.phase === 'approaching' && cpuCar.distance >= 0) {
                cpuCar.phase = 'flyby';
                const offset = (rand() * 2 - 1) * CPU_HOLD_SPEED_RANGE;
                cpuCar.holdSpeed = Math.max(40, Math.min(CPU_TOP_SPEED,
                    Math.round(speed + offset)));
                const sideWord = cpuCar.lane < lane ? 'left' : 'right';
                announce(`Challenger flies past on your ${sideWord}.`, {category: 'items'});
            }

            // Flyby → holding: CPU has traveled far enough ahead to start braking.
            if (cpuCar.phase === 'flyby' && cpuCar.distance > 80) {
                cpuCar.phase = 'holding';
            }

            // Track challenge distance accumulators (independent of relative motion).
            if (challengeState.active) {
                challengeState.playerDistance += (speed / 100) * 90 * delta;
                challengeState.cpuDistance += (cpuCar.speed / 100) * 90 * delta;
            }

            // Lane-change AI.
            cpuCar.laneChangeCooldown = Math.max(0, cpuCar.laneChangeCooldown - delta);

            // Avoid player's lane when close.
            if (!challengeState.active
                    && cpuCar.lane === lane
                    && Math.abs(cpuCar.distance) < CPU_AVOID_DISTANCE
                    && cpuCar.laneChangeCooldown === 0) {
                const candidates = [0, 1, 2].filter((l) => l !== lane);
                cpuCar.lane = candidates[Math.floor(rand() * candidates.length)];
                cpuCar.laneChangeCooldown = CPU_LANE_CHANGE_COOLDOWN;
            }

            // Booster targeting (challenge mode).
            if (challengeState.active && booster.active) {
                if (cpuCar.boosterTargetLane !== booster.lane) {
                    // Re-roll once per booster.
                    if (rand() < cpuAccuracy()) {
                        cpuCar.boosterTargetLane = booster.lane;
                    } else {
                        cpuCar.boosterTargetLane = -1; // explicit "ignore this one"
                    }
                }
                if (cpuCar.boosterTargetLane === booster.lane
                        && cpuCar.lane !== booster.lane
                        && cpuCar.laneChangeCooldown === 0) {
                    // Step one lane toward the booster.
                    if (cpuCar.lane < booster.lane) cpuCar.lane += 1;
                    else cpuCar.lane -= 1;
                    cpuCar.laneChangeCooldown = CPU_LANE_CHANGE_COOLDOWN * 0.6;
                }
            } else if (!booster.active && cpuCar.boosterTargetLane !== null) {
                cpuCar.boosterTargetLane = null;
            }

            if (cpuCar.awaitingHonk) {
                if (now >= cpuCar.handshakeNextHornAt
                        && cpuCar.hornAttempts < CPU_HORN_MAX_ATTEMPTS) {
                    playCpuHorn();
                    cpuCar.hornAttempts += 1;
                    cpuCar.handshakeNextHornAt = now + CPU_HORN_INTERVAL;
                }
                if (now >= cpuCar.handshakeExpiresAt) {
                    cpuCar.awaitingHonk = false;
                    cpuCar.phase = 'drivingAway';
                    announce(`Challenger taking off.`, {category: 'items'});
                }
            }

            // Car-on-car collision (covers both normal map and challenge mode).
            // Airborne player passes over the CPU — no contact.
            if (!jumping && cpuCar.lane === lane && Math.abs(cpuCar.distance) < CPU_COLLISION_DISTANCE) {
                handleCarCollision();
            }

            // Booster pickup checks (player + CPU).
            if (booster.active) {
                if (booster.lane === lane && Math.abs(booster.distance) < BOOSTER_PICKUP_DISTANCE) {
                    const amt = booster.boostMph;
                    playBoosterCue((smoothedLane - booster.lane) * LANE_SPACING);
                    applyBoostToPlayer(amt);
                    clearBooster();
                } else if (cpuCar.active
                        && booster.lane === cpuCar.lane
                        && Math.abs(booster.distance - cpuCar.distance) < BOOSTER_PICKUP_DISTANCE) {
                    const amt = booster.boostMph;
                    playBoosterCue((smoothedLane - booster.lane) * LANE_SPACING);
                    applyBoostToCpu(amt);
                    clearBooster();
                }
            }

            // Despawn once well behind (and not in a challenge).
            // Also despawn if the CPU overshot the player and is too far ahead —
            // but not while holding, since the car is intentionally stopped ahead
            // waiting for the player to accept or ignore the challenge.
            if (!challengeState.active && cpuCar.phase !== 'holding'
                    && cpuCar.distance >= CPU_FORWARD_DESPAWN) {
                despawnCpu();
                return;
            }
            if (!challengeState.active && cpuCar.distance <= CPU_DESPAWN_DISTANCE) {
                despawnCpu();
                return;
            }

            // Challenge win check.
            if (challengeState.active) {
                if (challengeState.playerDistance >= CHALLENGE_DISTANCE) {
                    endChallenge('player');
                } else if (challengeState.cpuDistance >= CHALLENGE_DISTANCE) {
                    endChallenge('cpu');
                }
            }
        }

        // ===== Car-on-car collision =====
        // Bump sound, random speed deduction on each car, and on the normal
        // map a 10–20 point health drop. Latches via a brief cooldown so a
        // single overlap doesn't fire every frame.
        let lastCarCollisionAt = 0;
        function handleCarCollision() {
            const now = syngen.time();
            if (now - lastCarCollisionAt < 0.5) return;
            lastCarCollisionAt = now;
            playBumpCue();
            const range = CHALLENGE_COLLISION_SPEED_MAX - CHALLENGE_COLLISION_SPEED_MIN;
            const playerLoss = CHALLENGE_COLLISION_SPEED_MIN + rand() * range;
            const cpuLoss = CHALLENGE_COLLISION_SPEED_MIN + rand() * range;
            // Scrub the player's actual speed only — targetSpeed stays put so the car
            // climbs back to it after the recovery hold (also lets a rocket-locked car
            // recover without throttle input).
            speed = Math.max(0, speed - playerLoss);
            accelHoldUntil = now + SLOWDOWN_RECOVERY_DELAY;
            cpuCar.speed = Math.max(0, cpuCar.speed - cpuLoss);
            // Nudge the CPU away from the player's lane so they don't grind.
            if (cpuCar.lane === lane && cpuCar.laneChangeCooldown === 0) {
                const candidates = [0, 1, 2].filter((l) => l !== lane);
                cpuCar.lane = candidates[Math.floor(rand() * candidates.length)];
                cpuCar.laneChangeCooldown = CPU_LANE_CHANGE_COOLDOWN;
            }
            if (!challengeState.active) {
                const healthLoss = CHALLENGE_COLLISION_HEALTH_MIN
                    + Math.floor(rand() * (CHALLENGE_COLLISION_HEALTH_MAX - CHALLENGE_COLLISION_HEALTH_MIN + 1));
                health = Math.max(0, health - healthLoss);
                if (health === 0) {
                    gameOver("You got taken out by the opponent!.");
                    return;
                }
            }
        }

        // ===== Reset hook for lifecycle =====
        // Clears every CPU/challenge/booster trace so startGame and gameOver
        // can call this without poking individual fields.
        function resetCpuRaceState() {
            if (cpuCar.active || cpuCar.synth) despawnCpu();
            if (booster.active) clearBooster();
            challengeState.active = false;
            challengeState.playerDistance = 0;
            challengeState.cpuDistance = 0;
            playerBoost.active = false;
            playerBoost.targetSpeed = 0;
            playerBoost.endsAt = 0;
            scheduleNextCpuSpawn();
        }

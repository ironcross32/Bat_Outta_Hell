        // Debug flag — gates dev-only hotkeys (e.g. M for peak-meter report).
        // build.js flips this to false when producing BOH-standalone.html so
        // shipped builds don't expose debug behaviour. The trailing comment
        // marker is what build.js looks for — don't remove it.
        const DEBUG = true; /* @debug-flag */

        // Game state
        let gameRunning = false;
        let paused = false;
        let speed = 0;
        let targetSpeed = 0;
        let lane = 1;
        let score = 0;
        // Spawn cadence is now driven by the world generator (js/world.js).
        // The legacy scheduleNextSpawn / nextSpawnAt / SPAWN_GAP_* family was
        // removed when spawning moved from time-based to distance-based chunks.
        const laneNames = ["Left Lane", "Middle Lane", "Right Lane"];

        // ── Tilt steering (device orientation) ───────────────────────────────
        // Positional steering: how far the phone is tilted from a calibrated
        // neutral directly selects the lane. Tilt left past TILT_TRIGGER_DEG →
        // left lane, hold level → middle lane, tilt right past TILT_TRIGGER_DEG
        // → right lane. The two thresholds give hysteresis around the middle so
        // small wobble near a boundary doesn't oscillate: you must exceed
        // TILT_TRIGGER_DEG to leave the middle into an outer lane, and fall back
        // within TILT_RECENTER_DEG of neutral to return to the middle. Neutral
        // is captured at game start (the player holds the phone level).
        const TILT_TRIGGER_DEG  = 15;  // degrees from neutral to select an outer lane
        const TILT_RECENTER_DEG = 5;   // come back within this of neutral for the middle lane
        let tiltNeutral = null;        // calibrated neutral signal (deg); null = recalibrate on next event
        let tiltListenerAttached = false;
        // True between the Start press and the orientation-cue chime: steering is
        // suspended and neutral capture is held off so the player has a couple of
        // seconds to orient the phone before we read the sensor. See
        // startTiltCalibrationCue() in input-rumble-gamepad.js.
        let tiltCalibratePending = false;
        // True while a Start press is waiting on the iOS permission prompt and the
        // calibration cue before the run actually begins. Guards against a second
        // Start press re-triggering the whole sequence while it's in flight.
        let tiltStartPending = false;
        // The *preference* (controlsOptions.tiltEnabled) is persisted and may be
        // restored from cache without a live OS permission. `tiltActive` is the
        // *runtime* truth: it flips true only once real orientation events start
        // arriving in-game, and resets each run. Touch flick steering falls back
        // on this so a stale/denied permission never leaves the player with no
        // lane control.
        let tiltActive = false;
        const lanePositionsX = [100, 300, 500];
        // Soundstage geometry: keep forward distance small relative to lateral lane offset
        // so the bearing to the obstacle is dominated by lane difference, not approach distance.
        // Otherwise a far obstacle 20m ahead and only ±2m off-axis only pans ~5° and feels
        // like it tracks the player when they switch lanes.
        const LANE_SPACING = 5;   // metres between lane centres on the soundstage
        const FORWARD_SCALE = 25; // obstacle.distance / FORWARD_SCALE = metres ahead (max ~4m)

        const obstacle = {
            lane: 1,
            distance: 100,
            active: false,
            passed: false,
            prop: null,
            // Tracks the smallest forward distance at which the player was still in
            // the obstacle's lane. Lower value = later swerve = bigger near-miss bonus.
            minSameLaneDistance: Infinity,
        };

        // Health / damage. Health resets to HEALTH_MAX on game start. Each crash
        // subtracts damage proportional to collision speed — a tap at idle costs
        // little, a head-on at 100 mph is fatal. Reaching 0 ends the run.
        const HEALTH_MAX = 100;
        let health = HEALTH_MAX;
        let gameStartTime = 0;

        // ===== Engine damage tiers =====
        // Low health makes the engine sick: roughness creeps in <75, gets blatant
        // <50, starts misfiring (audible pulse drop-outs) + backfiring <25, and
        // everything is exaggerated <10. Helpers below feed the engine audio
        // (engine.js), the accel/clamp math (loop.js), and the tire-scrub
        // bleed (input-rumble-gamepad.js).
        const HEALTH_ROUGH_GATE = 75;
        const HEALTH_BAD_GATE = 50;
        const HEALTH_MISFIRE_GATE = 25;
        const HEALTH_CRITICAL_GATE = 10;
        // Maps health → 0..1 "how sick is the engine" curve. Piecewise linear so
        // each tier's audible character starts cleanly at its threshold but still
        // ramps within the band — a 49% engine is meaningfully rougher than a 51%.
        function engineRoughness() {
            if (health >= HEALTH_ROUGH_GATE) return 0;
            if (health >= HEALTH_BAD_GATE) return (HEALTH_ROUGH_GATE - health) / (HEALTH_ROUGH_GATE - HEALTH_BAD_GATE) * 0.4;
            if (health >= HEALTH_MISFIRE_GATE) return 0.4 + (HEALTH_BAD_GATE - health) / (HEALTH_BAD_GATE - HEALTH_MISFIRE_GATE) * 0.35;
            if (health >= HEALTH_CRITICAL_GATE) return 0.75 + (HEALTH_MISFIRE_GATE - health) / (HEALTH_MISFIRE_GATE - HEALTH_CRITICAL_GATE) * 0.2;
            return Math.min(1, 0.95 + (HEALTH_CRITICAL_GATE - health) / HEALTH_CRITICAL_GATE * 0.05);
        }
        // Acceleration multiplier — same a(v) = A0(1 - v/V_INF) curve, just with
        // a flattened A0. Engine still climbs, just less eagerly.
        function accelHealthFactor() {
            if (health >= HEALTH_BAD_GATE) return 1.0;
            if (health >= HEALTH_MISFIRE_GATE) return 0.7;
            if (health >= HEALTH_CRITICAL_GATE) return 0.45;
            return 0.3;
        }
        // Top-speed clamp — below 25% the engine simply can't make 100 mph; below
        // 10% it's well off the pace. Applied to the throttle target in loop.js.
        function maxSpeedFromHealth() {
            if (health >= HEALTH_MISFIRE_GATE) return 100;
            if (health >= HEALTH_CRITICAL_GATE) return 90;
            return 75;
        }
        // Tire-scrub bleed (mph) on lane change. base = single change, cap =
        // ceiling for rapid-chain stacking. A wounded car loses far more speed
        // per swerve because the tires are already overworked.
        function laneScrubParams() {
            if (health >= HEALTH_BAD_GATE) return { base: 1, cap: 3 };
            if (health >= HEALTH_MISFIRE_GATE) return { base: 3, cap: 6 };
            if (health >= HEALTH_CRITICAL_GATE) return { base: 4.5, cap: 12 };
            return { base: 6, cap: 18 };
        }
        // Misfire/backfire scheduler state. Misfires gate the engine signal for a
        // few tens of ms (one or two firings drop out). Backfires play a pop/bang
        // *and* sap speed + suppress accel for a short window so the player
        // genuinely loses ground when the engine coughs.
        let misfireGate = null;
        let nextMisfireAt = 0;
        let nextBackfireAt = 0;
        let backfireActiveUntil = 0;
        // 0–1 tonal-disruption envelope set by triggerMisfire, decayed per frame in
        // updateEngineAudio. Drives extra FM mod depth so a miss reads as rasp, not silence.
        let misfireTimbre = 0;

        // ===== Near-miss streak =====
        // Consecutive near misses (nearMissFactor > 0.7). Resets on any non-near-miss
        // pass or crash. Bonus activates at NEAR_MISS_STREAK_MIN and scales linearly
        // to NEAR_MISS_MULT_MAX at NEAR_MISS_STREAK_CAP. Multiplier applies to the
        // full points awarded for that near miss.
        const NEAR_MISS_STREAK_MIN = 3;   // minimum consecutive near misses to earn bonus
        const NEAR_MISS_STREAK_CAP = 10;  // streak count where max multiplier is reached
        const NEAR_MISS_MULT_MIN = 1.5;   // multiplier at exactly MIN
        const NEAR_MISS_MULT_MAX = 5.0;   // multiplier at CAP and beyond
        let nearMissStreak = 0;

        // Run-wide statistics shown on the game-over screen. Reset in startGame().
        const stats = {
            speedSum: 0,
            speedFrames: 0,
            obstaclesAvoided: 0,
            nearMisses: 0,
            crashes: 0,
            gasCansCollected: 0,
            wrenchesCollected: 0,
            powerUpsCollected: 0,
            powerUpsByType: { shield: 0, rocket: 0, hornBall: 0 },
            hornBallsFired: 0,
            hornBallsHit: 0,
            hornBallsMissed: 0,
            shieldsAbsorbed: 0,
            sinkholesTraversed: 0,
            rampsHit: 0,
            rampsMissed: 0,
            totalAirTime: 0,
            coinsCollected: 0,
        };
        function resetStats() {
            stats.speedSum = 0;
            stats.speedFrames = 0;
            stats.obstaclesAvoided = 0;
            stats.nearMisses = 0;
            stats.crashes = 0;
            stats.gasCansCollected = 0;
            stats.wrenchesCollected = 0;
            stats.powerUpsCollected = 0;
            stats.powerUpsByType.shield = 0;
            stats.powerUpsByType.rocket = 0;
            stats.powerUpsByType.hornBall = 0;
            stats.hornBallsFired = 0;
            stats.hornBallsHit = 0;
            stats.hornBallsMissed = 0;
            stats.shieldsAbsorbed = 0;
            stats.sinkholesTraversed = 0;
            stats.rampsHit = 0;
            stats.rampsMissed = 0;
            stats.totalAirTime = 0;
            stats.coinsCollected = 0;
        }

        // ===== Low-speed penalty =====
        // Cruising below the threshold for too long erodes the score. A grace window
        // gives the player a chance to get up to speed at start and after crashes.
        const LOW_SPEED_THRESHOLD = 45;

        // ===== Fuel / gas can =====
        // Tank capacity normalised to 1.0. At 100 mph full throttle a full tank
        // lasts ~3 minutes; burn scales super-linearly with speed so cruising
        // sips and flooring it guzzles.
        const FUEL_MAX = 1.0;
        const FUEL_BURN_AT_100 = 1 / 180;     // tank per second at 100 mph
        const FUEL_BURN_EXPONENT = 1.4;       // (v/100)^this — superlinear w/ speed
        let fuel = FUEL_MAX;
        let outOfFuelAnnounced = false;

        const gasCan = {
            lane: 1,
            distance: 100,
            active: false,
            consumed: false,
            amount: 0,
            prop: null,
            nextCycleAt: 0,
        };
        const GAS_CAN_DESPAWN_AT = -50;
        const GAS_CAN_GAIN_MIN_DB = -22;
        const GAS_CAN_GAIN_MAX_DB = -6;
        const GAS_CAN_FILL_MIN = 0.25;        // quarter tank
        const GAS_CAN_FILL_MAX = 0.50;        // half tank

        // ===== Wrench / repair =====
        // Wrenches only appear once the player has actually taken damage (health < 75)
        // and arrive more frequently when things are dire (health < 25). They restore
        // a chunk of health on same-lane pickup.
        const WRENCH_HEALTH_GATE = 75;        // no wrench spawns above this
        const WRENCH_CRITICAL_HEALTH = 25;    // tighter spawn window below this
        const WRENCH_HEAL_AMOUNT = 30;        // health points restored per pickup
        const WRENCH_DESPAWN_AT = -50;
        const WRENCH_GAIN_MIN_DB = -22;
        const WRENCH_GAIN_MAX_DB = -6;
        const wrench = {
            lane: 1,
            distance: 100,
            active: false,
            consumed: false,
            prop: null,
            nextCycleAt: 0,
        };

        // Acoustic tuning
        const OBSTACLE_CARRIER_HZ = 425;   // ~half octave below the previous 600 Hz tone
        // Floor cutoff/gain set so the obstacle is clearly audible the moment it spawns
        // (distance=100), matching when a sighted player first sees it at the top of the
        // canvas. Earlier values (600 Hz / -28 dB) effectively muted the first half of the
        // approach — sighted testers reported obstacles visible for ~half a screen before
        // any sound. The curves below also open earlier in the approach for the same reason.
        const OBSTACLE_FILTER_MIN = 1400;  // cutoff when obstacle is far — lets harmonics through from spawn
        const OBSTACLE_FILTER_MAX = 20000; // cutoff at closest approach (fully open)
        const OBSTACLE_GAIN_MIN_DB = -20;  // gain when far
        const OBSTACLE_GAIN_MAX_DB = -6;   // gain at closest approach
        const OBSTACLE_DESPAWN_AT = -75;   // distance value at which a passed obstacle disappears
        // Manual Doppler: syngen's delay-line Doppler is too subtle on the forward axis because
        // our soundstage is small (max ~4m) and closure rate at top speed is only ~3.6 m/s — well
        // under 1% of c=343 m/s. We synthesize an audible shift by ramping the FM carrier with an
        // exaggerated effective speed of sound. Lateral motion still gets natural Doppler from the
        // delay line because lane-change easing produces ~25 m/s per-ear velocity briefly.
        const DOPPLER_EFFECTIVE_C = 50;    // m/s — lower = more audible pitch swing
        const DOPPLER_TRANSITION_M = 0.4;  // metres over which "approaching" smoothly becomes "receding"

        // Shared Doppler multiplier — same formula the obstacle uses, exposed
        // so every spatial prop (gas can, wrench, sinkhole, ramp, coins,
        // power-up pickup) can apply the same forward-axis pitch shift to
        // its tonal carriers. `distance` is the prop's forward-axis distance
        // in the game's per-prop units (positive = ahead, 0 = at the player).
        function dopplerMultiplier(distance) {
            const closureMps = (speed / 100) * 90 / FORWARD_SCALE;
            const direction = Math.tanh(distance / DOPPLER_TRANSITION_M);
            const closingRate = direction * closureMps;
            return DOPPLER_EFFECTIVE_C / (DOPPLER_EFFECTIVE_C - closingRate);
        }

        // Speed is auto-announced only when the *actual* vehicle speed crosses a
        // 25-mph bucket boundary, in either direction (accel or decel).
        const SPEED_ANNOUNCE_BUCKET = 25;
        let lastSpeedBucket = 0;
        let engineSynth = null;
        let engineTremolo = null;
        let engineReverbSend = null;
        let hornReverbSend = null;
        let engineTunnelSend = null;
        let hornTunnelSend = null;

        // Horn — dual-tone (minor third, 440 + 523 Hz) triangle pair,
        // amplitude-modulated at ~28 Hz for a buzzy-but-not-rough edge.
        // Triangle (not sawtooth) keeps a brassy character without the high
        // harmonics that fight the engine's FM sidebands. AM rate sits low
        // enough that its ±sidebands hug the carriers instead of colliding
        // with each other (which is what made the previous 70 Hz AM read as
        // ring-mod roughness). The engine is ducked ~3 dB while the horn is
        // open so the horn cuts through without raising its own level.
        const HORN_FREQ_LOW = 440;
        const HORN_FREQ_HIGH = 523;
        const HORN_AM_FREQ = 28;
        const HORN_AM_DEPTH = 0.15;     // fraction of base
        const HORN_GAIN_DB = -10;
        const HORN_ATTACK = 0.012;
        const HORN_RELEASE = 0.06;
        const HORN_ENGINE_DUCK_DB = -3;
        const HORN_REVERB_OUT_DB = -14;
        let hornNodes = null;
        let hornActive = false;

        // Throttle indicator — one short click fires each time targetSpeed crosses
        // into a new evenly-divided bucket. Pitch is the bucket's position in [0,1],
        // so steps up the throttle climb in pitch and steps down descend. Voiced as
        // a square ping for highs + a sub-octave sine for body + a mid-highpassed
        // noise transient — balanced so the clicks cut through the engine without
        // sounding brittle.
        const THROTTLE_BUCKET_SIZE = 20; // mph per bucket (0..100 → 6 distinct buckets)
        const THROTTLE_BUCKET_MAX = 100 / THROTTLE_BUCKET_SIZE;
        const THROTTLE_CLICK_PITCH_MIN = 2200;
        const THROTTLE_CLICK_PITCH_MAX = 6400;
        let lastThrottleBucket = 0;
        // Throttle is ramped continuously while ArrowUp/ArrowDown is held (in the
        // frame loop), instead of relying on OS key-repeat which has an initial
        // delay then a stuttery repeat rate. THROTTLE_RATE = mph of targetSpeed
        // change per second while held; 0..100 in ~1.7s.
        let throttleHeld = 0; // -1 down, 0 none, +1 up
        const THROTTLE_RATE = 120;

        // Drivetrain — targets 0–60 in 5.1s and 0–100 in 13.5s including 3 upshifts.
        // Powered acceleration uses a constant-power-ish curve a(v) = A0 * (1 - v/V_INF):
        // strong off the line, tapering as v approaches V_INF. Integrating gives
        // t(60) ≈ 4.1s and t(100) ≈ 11.9s of pure accel; the three 0.5s shifts make
        // up the rest of the wall-clock budget.
        const ACCEL_A0 = 21;        // mph/s at v=0
        const ACCEL_V_INF = 112;    // asymptotic top speed (mph) — accel = 0 here
        const DECEL_RATE = 18;      // mph/s when targetSpeed < speed (engine brake + coast)
        // Upshift road speeds (gear 1→2, 2→3, 3→4). Wider in low gears, tighter up top —
        // gives the familiar "long first, short fourth" spacing of a 4-speed auto.
        const SHIFT_POINTS_UP = [22, 48, 75];
        // Per-gear "mph → normalized RPM" multipliers. Chosen so each gear reaches
        // ~0.9–0.95 normalized RPM right at its upshift point (no flat-top "rev hang"
        // against the 1.05 RPM cap) and the next gear lands proportionally lower,
        // matching the audible RPM drop you hear on every upshift in a real auto.
        const GEAR_RATIOS = [1.0, 0.484, 0.310, 0.228];
        const RPM_REF = 24.44;      // mph that maps to normalized RPM = 1.0 in gear 1
        const IDLE_RPM = 0.12;      // floor — engine never sits at 0 RPM while running
        // Shift duration ≈ time for fluid pressure to build through the valve body and
        // engage the next clutch pack. Long enough to be audible, short enough not to
        // feel like a fault. RPM is smoothstep-eased over this window; torque is gone
        // (no acceleration) and engine gain dips slightly to mimic converter slip.
        const SHIFT_DURATION = 0.3;
        const SHIFT_ATTENUATION = 0.3; // mid-shift gain dip (fraction below nominal)

        let gear = 1;
        let shifting = false;
        let shiftElapsed = 0;
        let shiftFromRpm = IDLE_RPM;
        let shiftToGear = 1;

        function rpmInGear(g, v) {
            return Math.max(IDLE_RPM, Math.min(1.05, v * GEAR_RATIOS[g - 1] / RPM_REF));
        }

        // Hysteresis: downshift threshold is 15% below the upshift point of the gear
        // below us so light speed wobble around a shift point doesn't cause hunting.
        function desiredGear(v, currentGear) {
            if (currentGear < 4 && v >= SHIFT_POINTS_UP[currentGear - 1]) return currentGear + 1;
            if (currentGear > 1 && v < SHIFT_POINTS_UP[currentGear - 2] * 0.85) return currentGear - 1;
            return currentGear;
        }

        function currentRpm() {
            if (jumping) {
                // Rev arc: snap from pre-ramp RPM up to ~1.0 over JUMP_REV_UP_DURATION,
                // then wind down to idle over the (longer) JUMP_REV_DOWN_DURATION as
                // the engine coasts off-load. After that the engine sits at idle for
                // the rest of the airtime.
                const now = syngen.time();
                const elapsed = now - jumpStartedAt;
                if (elapsed < JUMP_REV_UP_DURATION) {
                    const u = elapsed / JUMP_REV_UP_DURATION;
                    return rpmInGear(gear, speed) + (1.0 - rpmInGear(gear, speed)) * u;
                }
                const downElapsed = elapsed - JUMP_REV_UP_DURATION;
                if (downElapsed < JUMP_REV_DOWN_DURATION) {
                    const u = downElapsed / JUMP_REV_DOWN_DURATION;
                    return 1.0 + (IDLE_RPM - 1.0) * u;
                }
                return IDLE_RPM;
            }
            if (!shifting) return rpmInGear(gear, speed);
            const p = Math.min(1, shiftElapsed / SHIFT_DURATION);
            const smooth = p * p * (3 - 2 * p);
            const toRpm = rpmInGear(shiftToGear, speed);
            return shiftFromRpm + (toRpm - shiftFromRpm) * smooth;
        }

        // Engine acoustic tuning
        // Base level for the engine. ~3 dB louder than the previous -16 dB design.
        const ENGINE_BASE_DB = -13;
        // V6 fundamental sweep — 50 Hz idle thrum up to ~200 Hz at full chat.
        // Real V6s sit roughly 30 Hz (idle) → 250 Hz (redline) on the firing fundamental;
        // this fits comfortably inside that envelope without going subsonic on cheap speakers.
        const ENGINE_FREQ_MIN = 40;
        const ENGINE_FREQ_MAX = 188;
        // Lowpass keeps the sawtooth from sounding buzzy/synth-y. Opens as revs climb
        // so higher harmonics come through under load — that's where the "growl" lives.
        const ENGINE_FILTER_MIN = 300;
        const ENGINE_FILTER_MAX = 1100;
        // Tremolo gives the idle "chop" — discrete cylinder firings audible at low RPM.
        // A V6 fires 3 times per crank revolution. We're not simulating gears, so we map
        // game speed → firing rate directly: 9 Hz "thumps" at 0 mph, ~55 Hz at 100 mph
        // (by which point individual pulses fuse into pitch and the LFO becomes inaudible —
        // which is realistic; high-RPM engines sound smooth precisely because the firings blur).
        const ENGINE_CHOP_FREQ_MIN = 9;
        const ENGINE_CHOP_FREQ_MAX = 55;
        // Chop depth as a fraction of base gain (full-scale ±). 0.85 at idle is heavy
        // but not clipping; fade to 0 by ~50 mph so cruising sounds steady.
        const ENGINE_CHOP_DEPTH_AT_IDLE = 0.85;
        const ENGINE_CHOP_FADE_SPEED = 50;
        // FM modulator depth in Hz — drives inharmonic grit/growl. Ramps with speed so
        // the engine keeps its character at high RPM instead of cleaning up into a
        // pure-sounding sawtooth lead. Real engines get rougher under load, not smoother.
        const ENGINE_MOD_DEPTH_MIN = 35;
        const ENGINE_MOD_DEPTH_MAX = 180;
        // ===== Lane-change speed bleed =====
        // Each lane change scrubs a small amount of speed (tire friction / weight
        // transfer). Rapid successive changes within LANE_CHANGE_RAPID_WINDOW
        // compound the bleed by the running count, up to LANE_CHANGE_BLEED_CAP.
        // targetSpeed is left alone so the car re-accelerates naturally afterward.
        const LANE_CHANGE_SPEED_BLEED = 1;   // mph lost on a single lane change
        const LANE_CHANGE_RAPID_WINDOW = 0.8; // seconds — window for "rapid" chain
        const LANE_CHANGE_BLEED_CAP = 3;    // max mph lost on any one change
        let lastLaneChangeAt = -Infinity;
        let rapidLaneChangeCount = 0;

        // Smoothed lane position used only for spatial audio. Snapping `lane` directly
        // into the StereoPanner causes an audible pan zip on lane change; an eased
        // value lets pan glide smoothly across the soundstage.
        let smoothedLane = 1;

        // Lateral range, in soundstage metres, that maps to a full hard-pan. With
        // LANE_SPACING = 5, a one-lane offset pans ~50%, a two-lane offset hard-pans.
        const PAN_RANGE_M = 10;
        function yToPan(y) {
            // +y is the player's left, so left of the listener = negative pan.
            const p = -y / PAN_RANGE_M;
            return p < -1 ? -1 : p > 1 ? 1 : p;
        }

        // A "critical" announce locks the floor for ~2s so casual chatter
        // (speed-bucket crossings, low-fuel updates, etc.) can't overwrite a
        // safety message before the screen reader has had time to speak it.
        // Used for the sinkhole spawn warning — verified that without the lock,
        // the speed-bucket announce was overwriting "Sink hole, X lane free"
        // within ~500ms of textContent being set.
        let announceCriticalUntil = 0;
        const ANNOUNCE_CRITICAL_HOLD_MS = 2000;
        function announce(text, opts) {
            const category = opts && opts.category;
            // Verbosity gate. Untagged announcements (game state — crash, pause,
            // out of fuel, game over, start, low-speed penalty) always pass; only
            // entity-presence and periodic-speed messages are user-suppressible.
            if (category && verbosity && verbosity[category] === false) return;
            const now = performance.now();
            const critical = !!(opts && opts.critical);
            if (!critical && now < announceCriticalUntil) return;
            if (critical) announceCriticalUntil = now + ANNOUNCE_CRITICAL_HOLD_MS;
            if (ttsOptions && ttsOptions.enabled) {
                ttsSpeakRaw(text);
            } else {
                announcer.textContent = '';
                setTimeout(() => { announcer.textContent = text; }, 50);
            }
        }

        // ===== CPU opponent + booster race =====
        // CPU car spawns behind the player, runs a full-speed flyby with a
        // Doppler horn, then decelerates to a hold speed near the player's.
        // Once settled it honks; player presses horn to accept the race or
        // ignores it and the CPU guns it away.
        const CPU_TOP_SPEED = 110;
        const CPU_APPROACH_SPEED = 130;       // mph during the flyby run
        const CPU_HOLD_SPEED_RANGE = 15;      // max mph offset for post-flyby hold speed
        const CPU_ACCEL_A0 = 24;              // a bit quicker off the line than the player
        const CPU_ACCEL_V_INF = 122;          // asymptotic top with no boost
        const CPU_DECEL_RATE = 15;            // gentler than the player's 18
        const CPU_SPAWN_INTERVAL_MIN = 15;    // seconds between challenger appearances
        const CPU_SPAWN_INTERVAL_MAX = 28;
        const CPU_SPAWN_DISTANCE = -120;      // negative = behind player
        const CPU_DESPAWN_DISTANCE = -260;    // far enough back that the engine is inaudible
        const CPU_FORWARD_DESPAWN = 150;      // despawn if CPU overshoots this far ahead
        const CPU_LANE_CHANGE_COOLDOWN = 1.2; // seconds between AI lane changes
        const CPU_AVOID_DISTANCE = 30;        // try to leave player's lane if within this
        const CPU_COLLISION_DISTANCE = 6;     // car-on-car collision threshold
        // Rotary engine voice — triangle modulator at 1.5× ratio gives the Wankel's
        // characteristic buzzsaw upper-harmonic texture vs the player's sub-octave grunt.
        // Higher freq/filter ceiling reflects the rotary's ability to live near redline.
        const CPU_ENGINE_BASE_DB = -14;
        const CPU_ENGINE_FREQ_MIN = 80;
        const CPU_ENGINE_FREQ_MAX = 340;      // screams brighter at redline than a piston V6
        const CPU_ENGINE_FILTER_MIN = 600;    // rotaries are bright even at idle
        const CPU_ENGINE_FILTER_MAX = 3200;   // very open at redline
        const CPU_ENGINE_CHOP_FREQ_MIN = 20;
        const CPU_ENGINE_CHOP_FREQ_MAX = 130; // higher firing rate per rev than piston
        const CPU_ENGINE_CHOP_DEPTH = 0.28;   // smoother — fewer amplitude valleys between firings
        const CPU_ENGINE_MOD_DEPTH_MIN = 15;
        const CPU_ENGINE_MOD_DEPTH_MAX = 160;
        // Five-gear rotary: shifts later than the player (rev to ~0.98 of cap
        // before stepping up) so the engine audibly screams between shifts.
        const CPU_SHIFT_POINTS_UP = [18, 38, 60, 84];
        const CPU_GEAR_RATIOS = [1.0, 0.500, 0.330, 0.255, 0.205];
        const CPU_RPM_REF = 19;               // mph that maps to normalized RPM = 1.0 in gear 1
        const CPU_IDLE_RPM = 0.14;
        const CPU_SHIFT_DURATION = 0.18;
        // Dual-tone challenge horn — E4 + G#4 (major third).
        const CPU_HORN_FREQ_LOW = 329.63;     // E4
        const CPU_HORN_FREQ_HIGH = 415.30;    // G#4
        const CPU_HORN_AM_FREQ = 24;
        const CPU_HORN_AM_DEPTH = 0.15;
        const CPU_HORN_GAIN_DB = -8;
        const CPU_HORN_DURATION = 0.55;
        const CPU_HORN_INTERVAL = 2.0;
        const CPU_HORN_MAX_ATTEMPTS = 3;
        // Challenge handshake gates.
        const CHALLENGE_SPEED_TOLERANCE = 8;       // mph window for "matching"
        const CHALLENGE_PROXIMITY = 30;            // units — also alongside-ish
        const CHALLENGE_DISTANCE = 3000;           // units to cover to win
        const CHALLENGE_BOOST_RAMP = 3;            // seconds from current speed → target
        const CHALLENGE_BOOST_HOLD = 2;            // seconds at the boosted target
        const CHALLENGE_BOOST_CAP = 175;           // absolute mph hard cap
        const CHALLENGE_BOOSTER_MIN_MPH = 10;
        const CHALLENGE_BOOSTER_MAX_MPH = 25;
        const CHALLENGE_AI_ACCURACY_MIN = 0.35;
        const CHALLENGE_AI_ACCURACY_MAX = 0.80;
        const CHALLENGE_AI_LEAD_SCALE = 300;       // units of lead that drag accuracy across the range
        const CHALLENGE_COLLISION_HEALTH_MIN = 10; // on the normal map only
        const CHALLENGE_COLLISION_HEALTH_MAX = 20;
        const CHALLENGE_COLLISION_SPEED_MIN = 8;
        const CHALLENGE_COLLISION_SPEED_MAX = 20;
        // Booster pickup tuning (mirrors the gas-can spatial shape).
        const BOOSTER_DESPAWN_AT = -50;
        const BOOSTER_GAIN_MIN_DB = -22;
        const BOOSTER_GAIN_MAX_DB = -6;
        const BOOSTER_PICKUP_DISTANCE = 4;

        const cpuCar = {
            active: false,
            lane: 0,
            distance: CPU_SPAWN_DISTANCE,
            speed: 0,
            targetSpeed: 0,
            gear: 1,
            currentRpm: CPU_IDLE_RPM,
            shifting: false,
            shiftElapsed: 0,
            shiftFromRpm: CPU_IDLE_RPM,
            shiftToGear: 1,
            synth: null,
            tremolo: null,
            panner: null,
            hornNodes: null,
            laneChangeCooldown: 0,
            // approach phases: 'approaching' | 'flyby' | 'holding' | 'drivingAway'
            phase: 'idle',
            holdSpeed: 0,
            deceleratedToHoldSpeed: false,
            flybyHornPlayed: false,
            awaitingHonk: false,
            hornAttempts: 0,
            handshakeNextHornAt: 0,
            handshakeExpiresAt: 0,
            boostActive: false,
            boostEndsAt: 0,
            boostHoldUntil: 0,
            boostTargetSpeed: 0,
            boostPrevTargetSpeed: 0,
            boosterTargetLane: null,
        };

        const challengeState = {
            active: false,
            startedAt: 0,
            playerStartPos: 0,
            cpuStartPos: 0,
            playerDistance: 0,
            cpuDistance: 0,
        };

        let nextCpuSpawnAt = 0;

        const booster = {
            lane: 1,
            distance: 100,
            active: false,
            consumed: false,
            boostMph: 0,
            synth: null,
            panner: null,
            gainNode: null,
            bus: null,
        };

        // Player-side booster state (so loop.js can clamp targetSpeed up to 175
        // and let the boost ramp/hold/release run independently of the rocket
        // power-up). The booster only modifies max-speed gating; it does NOT
        // replace the throttle target itself, it adds an additive boost above
        // whatever the player's throttle is asking for.
        const playerBoost = {
            active: false,
            endsAt: 0,
            holdUntil: 0,
            targetSpeed: 0,
        };

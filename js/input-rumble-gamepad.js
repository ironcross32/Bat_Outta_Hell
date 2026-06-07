        window.addEventListener('keydown', (e) => {
            // Pause toggle: Escape, or Ctrl+P. Handled before the gameRunning/paused
            // gate so it works in either state. Ctrl+P also needs preventDefault to
            // suppress the browser print dialog.
            if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P'))) {
                if (gameRunning) {
                    if (paused) resumeGame(); else pauseGame();
                    e.preventDefault();
                }
                return;
            }
            // Debug-only hotkeys. Gated on DEBUG (flipped to false at build
            // time so shipped standalones don't expose them).
            if (DEBUG) {
                // Audio peak meter report — works in any state (menu,
                // playing, paused) so you can baseline silence vs. gameplay.
                if (e.key === 'm' || e.key === 'M') {
                    reportPeaks();
                    e.preventDefault();
                    return;
                }
            }
            if (!gameRunning || paused) return;

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (e.repeat) return;       // OS repeat suppressed; we drive our own 500ms
                keyLaneHeldDir = -1;
                setLaneHeld(-1);
                return;
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (e.repeat) return;
                keyLaneHeldDir = 1;
                setLaneHeld(1);
                return;
            } else if (e.key === 'ArrowUp') {
                throttleHeld = 1;
                e.preventDefault();
            } else if (e.key === 'ArrowDown') {
                throttleHeld = -1;
                e.preventDefault();
            } else if (e.key === 'g' || e.key === 'G') {
                if (activePowerUp && activePowerUp.type === 'rocket') {
                    announce("You're too busy to look right now.");
                } else {
                    announce(describeFuel());
                }
                e.preventDefault();
            } else if (e.key === 'Shift') {
                if (activePowerUp) {
                    playPowerUpDeniedBuzz();
                    rumble.pulse(0.5, 0, 0.10);
                } else if (powerUpQueue.length > 0) {
                    const type = powerUpQueue.pop();
                    activatePowerUp(type);
                }
                e.preventDefault();
            } else if (e.key === 'p' || e.key === 'P') {
                announce(`Score: ${score}.`);
                e.preventDefault();
            } else if (e.key === 's' || e.key === 'S') {
                announce(`${Math.round(speed)} miles per hour.`);
                e.preventDefault();
            } else if (e.key === 'h' || e.key === 'H') {
                announce(`Health ${health} percent.`);
                e.preventDefault();
            } else if (e.key === ' ' || e.code === 'Space') {
                if (!e.repeat) {
                    startHorn();
                    // Honking back during the challenge handshake window
                    // accepts the race (only outside an active challenge).
                    if (typeof acceptChallenge === 'function') acceptChallenge();
                    if (activePowerUp && activePowerUp.type === 'hornBall' && !projectile.active && !jumping) {
                        spawnProjectile();
                    }
                }
                e.preventDefault();
            }

        });

        window.addEventListener('keyup', (e) => {
            if (e.key === ' ' || e.code === 'Space') {
                stopHorn();
                e.preventDefault();
            } else if (e.key === 'ArrowUp' && throttleHeld === 1) {
                throttleHeld = 0;
            } else if (e.key === 'ArrowDown' && throttleHeld === -1) {
                throttleHeld = 0;
            } else if (e.key === 'ArrowLeft' && keyLaneHeldDir === -1) {
                keyLaneHeldDir = 0;
                // If the gamepad stick is still held, hand control back to it; else release.
                if (lastPadStickDir !== 0) setLaneHeld(lastPadStickDir);
                else setLaneHeld(0);
            } else if (e.key === 'ArrowRight' && keyLaneHeldDir === 1) {
                keyLaneHeldDir = 0;
                if (lastPadStickDir !== 0) setLaneHeld(lastPadStickDir);
                else setLaneHeld(0);
            }
        });

        window.addEventListener('blur', () => { throttleHeld = 0; throttleAnalog = 0; laneHeld = 0; });

        // ===== Lane-change repeat =====
        // Both keyboard left/right and the gamepad left stick produce lane changes
        // on a fixed 500ms repeat rate while held — replacing the OS key-repeat
        // (which has an initial delay and a stuttery follow-up).
        const LANE_REPEAT_SECONDS = 0.5;
        let laneHeld = 0;            // -1, 0, +1
        let laneHeldNextAt = 0;      // next syngen.time() at which a held move fires

        function moveLane(dir) {
            if (!gameRunning || paused) return false;
            const prev = lane;
            if (dir < 0 && lane > 0) lane--;
            else if (dir > 0 && lane < 2) lane++;
            if (lane !== prev) {
                playLaneChangeCue(300 + lane * 100);
                announce(laneNames[lane], {category: 'lanes'});
                // Speed bleed: each change scrubs speed; rapid chain compounds.
                if (!jumping) {
                    const now = syngen.time();
                    if (now - lastLaneChangeAt < LANE_CHANGE_RAPID_WINDOW) {
                        rapidLaneChangeCount++;
                    } else {
                        rapidLaneChangeCount = 1;
                    }
                    lastLaneChangeAt = now;
                    // Wounded tires scrub more on every change — see laneScrubParams.
                    const { base, cap } = laneScrubParams();
                    const bleed = Math.min(base * rapidLaneChangeCount, cap);
                    speed = Math.max(0, speed - bleed);
                }
                return true;
            }
            return false;
        }

        function setLaneHeld(dir) {
            if (laneHeld === dir) return;
            laneHeld = dir;
            if (dir !== 0) {
                moveLane(dir);
                laneHeldNextAt = syngen.time() + LANE_REPEAT_SECONDS;
            }
        }

        // ===== Tilt steering (device orientation) =====
        // The headline feature: read the gyroscope and steer between the three
        // lanes by tilting the phone. The game is played in landscape held
        // roughly level, so the left/right steering axis is `beta` (front-back
        // pitch in the device's portrait frame becomes the screen's left-right
        // roll once rotated 90°). In portrait we fall back to `gamma`. The sign
        // of the landscape axis depends on which way the device was rotated, so
        // we flip it for the 270° orientation. Calibration (tiltNeutral) is
        // captured per run, so absolute offsets don't matter — only the delta.
        //
        // If left/right ever comes out reversed on a given device, flip the sign
        // of the `beta`/`gamma` returns below (this is the one place to change).
        function currentTiltAngle() {
            if (screen.orientation && typeof screen.orientation.angle === 'number') {
                return screen.orientation.angle;
            }
            if (typeof window.orientation === 'number') {
                return ((window.orientation % 360) + 360) % 360;
            }
            return 0;
        }

        function rawTiltSignal(e) {
            const beta  = (typeof e.beta  === 'number') ? e.beta  : 0;
            const gamma = (typeof e.gamma === 'number') ? e.gamma : 0;
            switch (currentTiltAngle()) {
                case 90:  return  beta;   // landscape (rotated counter-clockwise)
                case 270: return -beta;   // landscape (rotated clockwise)
                case 180: return -gamma;  // upside-down portrait
                default:  return  gamma;  // portrait
            }
        }

        function handleTilt(e) {
            if (!controlsOptions.tiltEnabled || !gameRunning || paused) return;
            // Hold off until the orientation cue's chime fires: don't steer and
            // don't capture neutral while the player is still settling the phone.
            if (tiltCalibratePending) return;
            const sig = rawTiltSignal(e);
            // First event of a run (or after a recalibrate) defines neutral.
            if (tiltNeutral === null) { tiltNeutral = sig; return; }
            // We're receiving real sensor data, so tilt is genuinely live — this
            // is what disables the touch flick fallback (see touch.js).
            tiltActive = true;
            const delta = sig - tiltNeutral;

            // Positional mapping with a hysteresis band around the middle lane:
            //   delta >  TRIGGER          → right lane
            //   delta < -TRIGGER          → left lane
            //   |delta| <  RECENTER       → middle lane
            //   (in between → hold whatever lane we're in: the deadband)
            let target = lane;
            if (delta > TILT_TRIGGER_DEG) target = 2;
            else if (delta < -TILT_TRIGGER_DEG) target = 0;
            else if (Math.abs(delta) < TILT_RECENTER_DEG) target = 1;

            // Step one lane toward the target. Events fire ~60Hz, so crossing two
            // lanes (left↔right) resolves over consecutive frames and never skips
            // the middle — and moveLane's per-change cue/announce/speed-bleed all
            // apply to each step, matching keyboard/gamepad lane changes.
            if (target > lane) moveLane(1);
            else if (target < lane) moveLane(-1);
        }

        function attachTiltListener() {
            if (tiltListenerAttached) return;
            window.addEventListener('deviceorientation', handleTilt);
            tiltListenerAttached = true;
        }

        // Force recalibration on the next sensor event. Called at the start of
        // every run so neutral matches however the player is holding the phone
        // right now.
        function calibrateTilt() {
            tiltNeutral = null;
            tiltActive = false;   // re-detect a live sensor from real events each run
        }

        // Orienting the phone for tilt steering is finicky — the player often has
        // to turn the screen reader off and get the phone level by feel — so on
        // Start we don't read neutral immediately. Instead we play a three-beat
        // cue, one beat per second: two A4 tones to count down, then a tri-tone
        // chime (A4 in the middle). Neutral is captured the moment the chime
        // sounds, giving the player ~2 s to settle the phone. tiltCalibratePending
        // (set by startGame) suspends steering/neutral-capture until the chime.
        const TILT_CAL_BEEP_HZ = 440;   // A4
        function startTiltCalibrationCue(onComplete) {
            playCue(TILT_CAL_BEEP_HZ, 0.45, 'sine', -10);
            setTimeout(() => playCue(TILT_CAL_BEEP_HZ, 0.45, 'sine', -10), 1000);
            setTimeout(() => {
                playTiltCalibrationChime();
                // Read the sensor now: drop neutral and clear the hold so the next
                // orientation event captures however the phone is being held as the
                // chime plays.
                tiltNeutral = null;
                tiltCalibratePending = false;
                // Calibration done — let the caller begin the run.
                if (typeof onComplete === 'function') onComplete();
            }, 2000);
        }

        // F-major arpeggio — F4 → A4 → C5 — so A4 lands in the middle of the chime.
        function playTiltCalibrationChime() {
            playCue(349.23, 0.50, 'sine', -10);                          // F4
            setTimeout(() => playCue(440.00, 0.50, 'sine', -10), 120);   // A4
            setTimeout(() => playCue(523.25, 0.60, 'sine', -10), 240);   // C5
        }

        // Must be called from a user gesture (checkbox toggle or Start button).
        // iOS 13+ gates the sensor behind requestPermission(); Android/desktop
        // expose it freely. Resolves true when orientation events will flow.
        function ensureTiltPermission() {
            if (typeof DeviceOrientationEvent === 'undefined') return Promise.resolve(false);
            if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                return DeviceOrientationEvent.requestPermission()
                    .then((state) => state === 'granted')
                    .catch(() => false);
            }
            return Promise.resolve(true);
        }

        // On a cached load where tilt was previously enabled, attach the listener
        // immediately. Android resumes steering right away; iOS won't deliver
        // events until permission is (re-)granted from a gesture — that happens
        // on the next checkbox toggle or Start click (see ensureTiltPermission).
        if (controlsOptions.tiltEnabled) attachTiltListener();

        // ===== Rumble =====
        // Dual-rumble output for connected gamepads. Two pools:
        //   - sources: keyed continuous channels with {left, right} 0..1, callers
        //     update each frame (obstacle proximity, sinkhole pattern, etc).
        //   - pulses: one-shot {left, right, endsAt} added by event triggers
        //     (lane swerve confirmations, ramp jump, hits, etc).
        // Each frame we max across all sources + active pulses and push the
        // combined intensities to every connected pad's vibrationActuator.
        // Refresh cadence: re-push when values change meaningfully, otherwise
        // every ~80ms so the actuator's internal effect doesn't lapse.
        // Convention: left = strong (low-frequency) motor, right = weak (high-frequency).
        const rumble = (() => {
            const sources = new Map();
            const pulses = [];
            let lastLeft = -1, lastRight = -1, lastSentAt = 0;
            let lastTickTime = 0;

            // World-item rumble drops to 65% strength when the player isn't in
            // the item's lane, ramped linearly over 300 ms so the change is felt
            // as a swell/duck rather than a step. sameLane defaults to true so
            // sources that don't carry lane info (or pulse one-shots) stay full.
            const ATTENUATION_OFF_LANE = 0.3;
            const ATTENUATION_RAMP_SECONDS = 0.3;
            function setSource(key, left, right, sameLane) {
                const target = (sameLane === undefined || sameLane) ? 1.0 : ATTENUATION_OFF_LANE;
                let s = sources.get(key);
                if (!s) {
                    // First setSource for this key — start at the target attenuation
                    // so a brand-new prop doesn't ramp in from full strength while
                    // the player is already off-lane.
                    s = { left: 0, right: 0, current: target, target };
                    sources.set(key, s);
                }
                s.left = left || 0;
                s.right = right || 0;
                s.target = target;
            }
            function clearSource(key) { sources.delete(key); }
            function pulse(left, right, duration) {
                pulses.push({
                    left: left || 0,
                    right: right || 0,
                    endsAt: syngen.time() + duration,
                });
            }
            function pushToPad(left, right) {
                if (!navigator.getGamepads) return;
                const pads = navigator.getGamepads();
                for (const pad of pads) {
                    if (!pad || !pad.vibrationActuator) continue;
                    try {
                        pad.vibrationActuator.playEffect('dual-rumble', {
                            startDelay: 0,
                            duration: 150,
                            strongMagnitude: left,
                            weakMagnitude: right,
                        });
                    } catch (e) {}
                }
            }
            function tick() {
                const now = syngen.time();
                const dt = lastTickTime ? Math.max(0, now - lastTickTime) : 0;
                lastTickTime = now;
                const step = ATTENUATION_RAMP_SECONDS > 0 ? dt / ATTENUATION_RAMP_SECONDS : 1;
                let left = 0, right = 0;
                for (const s of sources.values()) {
                    if (s.current < s.target) s.current = Math.min(s.target, s.current + step);
                    else if (s.current > s.target) s.current = Math.max(s.target, s.current - step);
                    const l = s.left * s.current;
                    const r = s.right * s.current;
                    if (l > left) left = l;
                    if (r > right) right = r;
                }
                for (let i = pulses.length - 1; i >= 0; i--) {
                    if (now >= pulses[i].endsAt) { pulses.splice(i, 1); continue; }
                    if (pulses[i].left > left) left = pulses[i].left;
                    if (pulses[i].right > right) right = pulses[i].right;
                }
                if (left > 1) left = 1; if (left < 0) left = 0;
                if (right > 1) right = 1; if (right < 0) right = 0;
                const changed = Math.abs(left - lastLeft) > 0.02
                    || Math.abs(right - lastRight) > 0.02;
                const stale = (now - lastSentAt) > 0.08;
                if (changed || stale) {
                    pushToPad(left, right);
                    lastLeft = left;
                    lastRight = right;
                    lastSentAt = now;
                }
            }
            function stopAll() {
                sources.clear();
                pulses.length = 0;
                pushToPad(0, 0);
                if (navigator.getGamepads) {
                    const pads = navigator.getGamepads();
                    for (const pad of pads) {
                        if (pad && pad.vibrationActuator && pad.vibrationActuator.reset) {
                            try { pad.vibrationActuator.reset(); } catch (e) {}
                        }
                    }
                }
                lastLeft = -1; lastRight = -1; lastSentAt = 0;
                lastTickTime = 0;
            }
            return { setSource, clearSource, pulse, tick, stopAll };
        })();

        // ===== Gamepad =====
        // Standard Gamepad mapping:
        //   buttons[0]=A (horn / horn-ball — press+hold mirrors keyboard Space;
        //     with LB held, speaks speed instead),
        //   [1]=B (LB+B speaks score), [2]=X (LB+X speaks fuel),
        //   [3]=Y (LB+Y speaks health), [4]=LB (shift modifier — when held,
        //     face buttons use their shifted function),
        //   [5]=RB (activate power-up),
        //   [6]=LT and [7]=RT (analog throttle), [9]=Start/Menu (pause toggle).
        //   axes[0] = left stick X (lane).
        // syngen.input.gamepad.update() runs as part of the syngen frame loop
        // (registered when syngen.js loads, before this script). So when our
        // frame handler reads state, it's already up to date for this frame.
        const GAMEPAD_STICK_THRESHOLD = 0.5;
        const GAMEPAD_BTN_A = 0;
        const GAMEPAD_BTN_SCORE = 1;
        const GAMEPAD_BTN_FUEL = 2;
        const GAMEPAD_BTN_HEALTH = 3;
        const GAMEPAD_BTN_SHIFT = 4;
        const GAMEPAD_BTN_POWERUP = 5;
        const GAMEPAD_BTN_LT = 6;
        const GAMEPAD_BTN_RT = 7;
        const GAMEPAD_BTN_MENU = 9;
        const GAMEPAD_BTN_DPAD_UP = 12;
        const GAMEPAD_BTN_DPAD_DOWN = 13;
        const GAMEPAD_BTN_DPAD_LEFT = 14;
        const GAMEPAD_BTN_DPAD_RIGHT = 15;
        const GAMEPAD_TRIGGER_DEADZONE = 0.05;
        let lastPadDigital = {};
        let lastPadStickDir = 0;
        let hornHeldByPad = false;
        // Net analog throttle from the triggers: RT - LT, in [-1, 1]. Read each
        // frame and applied in the main tick (scales THROTTLE_RATE * delta).
        // Keyboard ArrowUp/Down still works and takes precedence when held.
        let throttleAnalog = 0;

        // Visible, focusable DOM elements in document order. Used to drive UI
        // focus from the D-pad while no game is running (initial menu and the
        // game-over dialog). offsetParent === null filters out elements inside
        // `hidden` containers, so the instructions glossary buttons only appear
        // here when the panel is expanded.
        function focusableElements() {
            const sel = 'button, [tabindex]:not([tabindex="-1"]), a[href], input, select, textarea';
            return Array.from(document.querySelectorAll(sel))
                .filter(el => !el.disabled && el.offsetParent !== null);
        }
        function moveUiFocus(dir) {
            const list = focusableElements();
            if (!list.length) return;
            let idx = list.indexOf(document.activeElement);
            if (idx === -1) idx = dir > 0 ? -1 : list.length;
            idx = (idx + dir + list.length) % list.length;
            list[idx].focus();
        }

        function gamepadTick() {
            // Be tolerant if syngen.input.gamepad isn't present (older syngen build).
            if (!syngen.input || !syngen.input.gamepad) return;
            const state = syngen.input.gamepad.get();

            // Edge-detected buttons: only fire on rising edge to avoid repeats.
            function pressed(idx) {
                const now = !!state.digital[idx];
                const was = !!lastPadDigital[idx];
                lastPadDigital[idx] = now;
                return now && !was;
            }

            if (pressed(GAMEPAD_BTN_MENU)) {
                if (gameRunning) {
                    if (paused) resumeGame(); else pauseGame();
                }
            }

            // No active game (start menu OR game-over screen): D-pad drives UI
            // focus and A clicks the focused control, so the whole flow —
            // Start, Play Again, instructions toggle, statistics toggle, sound
            // previews — can be reached without leaving the controller.
            if (!gameRunning) {
                const up = pressed(GAMEPAD_BTN_DPAD_UP);
                const left = pressed(GAMEPAD_BTN_DPAD_LEFT);
                const down = pressed(GAMEPAD_BTN_DPAD_DOWN);
                const right = pressed(GAMEPAD_BTN_DPAD_RIGHT);
                if (up || left) moveUiFocus(-1);
                if (down || right) moveUiFocus(1);
                if (pressed(GAMEPAD_BTN_A)) {
                    const el = document.activeElement;
                    if (el && typeof el.click === 'function') el.click();
                }
                // Consume in-game edges so nothing fires mid-menu.
                pressed(GAMEPAD_BTN_SCORE);
                pressed(GAMEPAD_BTN_FUEL);
                pressed(GAMEPAD_BTN_HEALTH);
                pressed(GAMEPAD_BTN_POWERUP);
                pressed(GAMEPAD_BTN_SHIFT);
                if (hornHeldByPad) { stopHorn(); hornHeldByPad = false; }
                lastPadStickDir = 0;
                throttleAnalog = 0;
                if (laneHeld !== 0 && !keyLaneHeldDir) laneHeld = 0;
                return;
            }

            if (paused) {
                // Consume all in-game edges so they don't queue across the
                // pause boundary; menu (handled above) is the only allowed
                // input from the controller while paused.
                pressed(GAMEPAD_BTN_A);
                pressed(GAMEPAD_BTN_SCORE);
                pressed(GAMEPAD_BTN_FUEL);
                pressed(GAMEPAD_BTN_HEALTH);
                pressed(GAMEPAD_BTN_POWERUP);
                pressed(GAMEPAD_BTN_SHIFT);
                if (hornHeldByPad) { stopHorn(); hornHeldByPad = false; }
                pressed(GAMEPAD_BTN_DPAD_UP);
                pressed(GAMEPAD_BTN_DPAD_DOWN);
                pressed(GAMEPAD_BTN_DPAD_LEFT);
                pressed(GAMEPAD_BTN_DPAD_RIGHT);
                lastPadStickDir = 0;
                throttleAnalog = 0;
                if (laneHeld !== 0 && !keyLaneHeldDir) laneHeld = 0;
                return;
            }

            // Consume D-pad edges in the running branch so a stray d-pad press
            // doesn't bleed into the next non-running state.
            pressed(GAMEPAD_BTN_DPAD_UP);
            pressed(GAMEPAD_BTN_DPAD_DOWN);
            pressed(GAMEPAD_BTN_DPAD_LEFT);
            pressed(GAMEPAD_BTN_DPAD_RIGHT);

            // Triggers → analog throttle (RT accelerates, LT decelerates).
            // Press-style buttons on a standard Gamepad expose their analog
            // depth via `analog` (syngen's accumulated `button.value`).
            const lt = state.analog[GAMEPAD_BTN_LT] || 0;
            const rt = state.analog[GAMEPAD_BTN_RT] || 0;
            const net = rt - lt;
            throttleAnalog = Math.abs(net) > GAMEPAD_TRIGGER_DEADZONE ? net : 0;

            // LB acts as a "shift" modifier: when held, face-button presses
            // route to their shifted action (status announcements) instead of
            // the primary action. Shift state is sampled at the press edge so
            // releasing LB mid-press doesn't change what a held button is
            // already doing (e.g. a horn started without shift keeps honking).
            const shiftHeld = !!state.digital[GAMEPAD_BTN_SHIFT];

            // A = horn / horn-ball (primary) or speak speed (shifted).
            // Done inline rather than via pressed()/released() because each of
            // those helpers writes lastPadDigital, so the second call wouldn't
            // see the prior frame's state.
            {
                const aNow = !!state.digital[GAMEPAD_BTN_A];
                const aWas = !!lastPadDigital[GAMEPAD_BTN_A];
                lastPadDigital[GAMEPAD_BTN_A] = aNow;
                if (aNow && !aWas) {
                    if (shiftHeld) {
                        announce(`${Math.round(speed)} miles per hour.`);
                    } else {
                        startHorn();
                        hornHeldByPad = true;
                        if (typeof acceptChallenge === 'function') acceptChallenge();
                        if (activePowerUp && activePowerUp.type === 'hornBall' && !projectile.active && !jumping) {
                            spawnProjectile();
                        }
                    }
                } else if (!aNow && aWas) {
                    if (hornHeldByPad) {
                        stopHorn();
                        hornHeldByPad = false;
                    }
                }
            }
            if (pressed(GAMEPAD_BTN_SCORE) && shiftHeld) {
                announce(`Score: ${score}.`);
            }
            if (pressed(GAMEPAD_BTN_FUEL) && shiftHeld) {
                if (activePowerUp && activePowerUp.type === 'rocket') {
                    announce("You're too busy to look right now.");
                } else {
                    announce(describeFuel());
                }
            }
            if (pressed(GAMEPAD_BTN_HEALTH) && shiftHeld) {
                announce(`Health ${health} percent.`);
            }

            if (pressed(GAMEPAD_BTN_POWERUP)) {
                if (activePowerUp) {
                    playPowerUpDeniedBuzz();
                    rumble.pulse(0.5, 0, 0.10);
                } else if (powerUpQueue.length > 0) {
                    activatePowerUp(powerUpQueue.pop());
                }
            }

            // Left stick → lane. Mirror keyboard ArrowLeft/Right semantics:
            // crossing the threshold counts as a press; staying past it holds
            // and triggers the 500ms repeat in the frame loop. Stick wins over
            // the keyboard only when the keyboard isn't actively held.
            const x = state.axis[0] || 0;
            let stickDir = 0;
            if (x <= -GAMEPAD_STICK_THRESHOLD) stickDir = -1;
            else if (x >= GAMEPAD_STICK_THRESHOLD) stickDir = 1;

            if (stickDir !== lastPadStickDir) {
                if (keyLaneHeldDir === 0) {
                    setLaneHeld(stickDir);
                }
                lastPadStickDir = stickDir;
            }
        }
        // Tracks which arrow key is currently held; gamepad stick only drives
        // laneHeld when no keyboard arrow is active so the two inputs don't fight.
        let keyLaneHeldDir = 0;


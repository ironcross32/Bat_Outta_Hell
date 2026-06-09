        // Touch input for mobile play.
        //
        // The canvas splits into three columns: a vertical horn strip at each
        // end (HORN_STRIP_FRACTION of the width) and a central gesture zone.
        //
        // HORN STRIPS (left / right ends, single finger)
        //   Press & hold    — honk the horn for as long as held; also fires the
        //                      Horn ball power-up when one is active
        //
        // Everything below happens in the central gesture zone only.
        //
        // SINGLE FINGER
        //   Vertical drag   — throttle (positional setter; half canvas height = full range)
        //   Horizontal flick — lane change left/right (when tilt steering isn't live)
        //
        // TWO FINGERS
        //   Tap             — activate power-up
        //   Swipe up        — announce score
        //   Swipe down      — announce speed
        //   Swipe left      — announce fuel
        //   Swipe right     — announce health
        //
        // THREE FINGERS
        //   Tap             — pause / unpause
        //
        // Multi-touch (≥2 fingers) cancels any in-progress single-finger throttle
        // so the two gesture classes don't interfere.

        // ── Throttle state (single finger) ───────────────────────────────────
        let touchThrottleActive = false;
        let touchThrottleTarget = 0;
        let _touchThrottleId    = -1;
        let _touchAnchorX       = 0;
        let _touchAnchorY       = 0;
        let _touchAnchorSpeed   = 0;
        let _touchStartTime     = 0;
        let _touchLastX         = 0;
        let _touchLastY         = 0;

        // Three-quarters of the displayed canvas height covers the full speed
        // range. A larger fraction = lower sensitivity (more drag per mph), which
        // makes small speed adjustments easier to dial in.
        const TOUCH_THROTTLE_HEIGHT_FRACTION = 0.75;

        // Single-finger flick thresholds.
        const FLICK_MAX_MS = 300;
        const FLICK_MIN_PX = 40;

        // ── Multi-touch state ─────────────────────────────────────────────────
        // Tracks every active touch: id → { startX, startY, startTime, lastX, lastY }
        const _mt = new Map();

        // A multi-finger gesture rarely lifts all fingers within a single
        // touchend event — they release a few ms apart, across separate events.
        // So we remember the peak simultaneous finger count for the current
        // gesture and accumulate lifted-finger records, firing the gesture only
        // once the last finger is up. (The old "all fingers in one touchend"
        // check is why multi-finger gestures felt flaky.)
        let _mtPeak = 0;
        const _mtLifted = [];

        // Tap detection: all fingers must lift within this time and move less than
        // TAP_MAX_PX from their start position.
        const TAP_MAX_MS = 300;
        const TAP_MAX_PX = 20;

        // Swipe detection: average displacement must exceed this.
        const SWIPE_MIN_PX = 40;

        // ── Horn strips (single finger) ───────────────────────────────────────
        // A vertical strip at each end of the canvas honks the horn for as long
        // as a finger is held there, leaving the middle as the gesture zone for
        // throttle / flick / multi-finger gestures. A finger that starts in a
        // strip is horn-only — it never feeds the throttle or the multi-touch
        // tracker. Holding the horn is also how the Horn ball power-up fires on
        // mobile (mirrors the spacebar path in input-rumble-gamepad.js).
        const HORN_STRIP_FRACTION = 0.18;   // each side strip = 18% of width
        const _hornTouchIds = new Set();    // active horn fingers (horn on while non-empty)

        function _inHornStrip(clientX, rect) {
            return clientX < rect.left  + rect.width * HORN_STRIP_FRACTION ||
                   clientX > rect.right - rect.width * HORN_STRIP_FRACTION;
        }

        function _abortThrottle() {
            if (touchThrottleActive) {
                touchThrottleActive = false;
                _touchThrottleId = -1;
                // Leave targetSpeed where the partial drag left it — better than
                // snapping back to anchor on an accidental two-finger touch.
            }
        }

        function _handleMultiGesture(touches) {
            // touches = array of { startX, startY, startTime, lastX, lastY }
            if (!gameRunning) return;

            const count = touches.length;
            const now   = performance.now();

            // Check if all touches qualify as a tap (fast + minimal movement).
            const isTap = touches.every(t =>
                (now - t.startTime) < TAP_MAX_MS &&
                Math.abs(t.lastX - t.startX) < TAP_MAX_PX &&
                Math.abs(t.lastY - t.startY) < TAP_MAX_PX
            );

            if (count === 3) {
                if (isTap) {
                    if (paused) resumeGame(); else pauseGame();
                }
                return;
            }

            if (count === 2) {
                if (isTap) {
                    if (!paused) {
                        if (activePowerUp) {
                            playPowerUpDeniedBuzz();
                        } else if (powerUpQueue.length > 0) {
                            const type = powerUpQueue.pop();
                            activatePowerUp(type);
                        }
                    }
                    return;
                }

                // Swipe: average displacement across both fingers.
                const avgDx = touches.reduce((s, t) => s + (t.lastX - t.startX), 0) / 2;
                const avgDy = touches.reduce((s, t) => s + (t.lastY - t.startY), 0) / 2;
                const absDx = Math.abs(avgDx);
                const absDy = Math.abs(avgDy);

                if (Math.max(absDx, absDy) < SWIPE_MIN_PX) return;

                if (!paused && absDy > absDx) {
                    // Vertical swipe.
                    if (avgDy < 0) {
                        announce(`Score: ${score}.`);
                    } else {
                        announce(`${Math.round(speed)} miles per hour.`);
                    }
                } else if (!paused) {
                    // Horizontal swipe.
                    if (avgDx < 0) {
                        announce(describeFuel());
                    } else {
                        announce(`Health ${health} percent.`);
                    }
                }
            }
        }

        (function initTouch() {
            const cv = document.getElementById('gameCanvas');
            if (!cv) return;

            cv.addEventListener('touchstart', (e) => {
                e.preventDefault();
                const rect = cv.getBoundingClientRect();

                for (const t of e.changedTouches) {
                    // A finger in a side strip is horn-only; keep it out of the
                    // gesture-zone tracker entirely.
                    if (_inHornStrip(t.clientX, rect)) {
                        const wasEmpty = _hornTouchIds.size === 0;
                        _hornTouchIds.add(t.identifier);
                        if (wasEmpty && gameRunning && !paused) {
                            startHorn();
                            if (activePowerUp && activePowerUp.type === 'hornBall' &&
                                !projectile.active && !jumping) {
                                spawnProjectile();
                            }
                        }
                        continue;
                    }
                    _mt.set(t.identifier, {
                        startX: t.clientX, startY: t.clientY,
                        startTime: performance.now(),
                        lastX: t.clientX,  lastY: t.clientY,
                    });
                }
                if (_mt.size > _mtPeak) _mtPeak = _mt.size;

                // If two or more gesture-zone fingers are down, cancel throttle.
                if (_mt.size >= 2) {
                    _abortThrottle();
                    return;
                }

                // Single gesture-zone finger — start throttle tracking.
                if (!gameRunning || paused) return;
                if (touchThrottleActive) return;
                if (_mt.size !== 1) return;
                let t = null;
                for (const ct of e.changedTouches) {
                    if (_mt.has(ct.identifier)) { t = ct; break; }
                }
                if (!t) return;
                _touchThrottleId  = t.identifier;
                _touchAnchorX     = t.clientX;
                _touchAnchorY     = t.clientY;
                _touchLastX       = t.clientX;
                _touchLastY       = t.clientY;
                _touchAnchorSpeed = targetSpeed;
                _touchStartTime   = performance.now();
                touchThrottleActive = true;
            }, { passive: false });

            cv.addEventListener('touchmove', (e) => {
                e.preventDefault();

                for (const t of e.changedTouches) {
                    if (_mt.has(t.identifier)) {
                        const rec = _mt.get(t.identifier);
                        rec.lastX = t.clientX;
                        rec.lastY = t.clientY;
                    }
                }

                if (!touchThrottleActive) return;
                for (const t of e.changedTouches) {
                    if (t.identifier !== _touchThrottleId) continue;
                    _touchLastX = t.clientX;
                    _touchLastY = t.clientY;
                    const rect   = cv.getBoundingClientRect();
                    const dragUp = _touchAnchorY - t.clientY;
                    const maxSpd = maxSpeedFromHealth();
                    touchThrottleTarget = _touchAnchorSpeed +
                        dragUp * (maxSpd / (rect.height * TOUCH_THROTTLE_HEIGHT_FRACTION));
                    break;
                }
            }, { passive: false });

            cv.addEventListener('touchend', (e) => {
                e.preventDefault();

                // Horn strip releases — horn stays on until the last one lifts.
                for (const t of e.changedTouches) {
                    if (_hornTouchIds.delete(t.identifier) && _hornTouchIds.size === 0) {
                        stopHorn();
                    }
                }

                // Accumulate the records for fingers that just lifted. Fingers in
                // a multi-finger gesture usually release across several touchend
                // events, so we keep collecting until the map empties.
                for (const t of e.changedTouches) {
                    if (_mt.has(t.identifier)) {
                        _mtLifted.push(_mt.get(t.identifier));
                        _mt.delete(t.identifier);
                    }
                }

                // Once the last finger is up, fire the multi-touch gesture if the
                // gesture ever involved ≥2 fingers, then reset for the next one.
                if (_mt.size === 0) {
                    if (_mtPeak >= 2) {
                        _handleMultiGesture(_mtLifted.slice());
                    } else if (_mtPeak === 1 && !gameRunning && _mtLifted.length === 1) {
                        const rec = _mtLifted[0];
                        const now = performance.now();
                        if ((now - rec.startTime) < TAP_MAX_MS &&
                            Math.abs(rec.lastX - rec.startX) < TAP_MAX_PX &&
                            Math.abs(rec.lastY - rec.startY) < TAP_MAX_PX) {
                            startGame();
                        }
                    }
                    _mtLifted.length = 0;
                    _mtPeak = 0;
                }

                // Single-finger throttle / flick resolution.
                for (const t of e.changedTouches) {
                    if (t.identifier !== _touchThrottleId) continue;
                    touchThrottleActive = false;
                    _touchThrottleId = -1;

                    // Flick steering is the fallback whenever tilt isn't actually
                    // driving lanes — i.e. tilt off, or enabled-but-not-yet-live
                    // (permission stale/denied). See `tiltActive` in state.js.
                    if (!tiltActive) {
                        const dt    = performance.now() - _touchStartTime;
                        const dx    = _touchLastX - _touchAnchorX;
                        const dy    = _touchLastY - _touchAnchorY;
                        const absDx = Math.abs(dx);
                        const absDy = Math.abs(dy);
                        if (dt < FLICK_MAX_MS && absDx >= FLICK_MIN_PX && absDx > absDy) {
                            targetSpeed = _touchAnchorSpeed;
                            touchThrottleTarget = _touchAnchorSpeed;
                            moveLane(dx < 0 ? -1 : 1);
                        }
                    }
                    break;
                }
            }, { passive: false });

            cv.addEventListener('touchcancel', (e) => {
                for (const t of e.changedTouches) {
                    _mt.delete(t.identifier);
                    if (_hornTouchIds.delete(t.identifier) && _hornTouchIds.size === 0) {
                        stopHorn();
                    }
                }
                if (_mt.size === 0) {
                    _mtLifted.length = 0;
                    _mtPeak = 0;
                }
                touchThrottleActive = false;
                _touchThrottleId = -1;
            }, { passive: false });
        })();

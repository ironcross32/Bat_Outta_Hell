        // Touch input for mobile play.
        //
        // SINGLE FINGER
        //   Vertical drag   — throttle (positional setter; half canvas height = full range)
        //   Horizontal flick — lane change left/right (when tilt steering is off)
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

        // Tap detection: all fingers must lift within this time and move less than
        // TAP_MAX_PX from their start position.
        const TAP_MAX_MS = 300;
        const TAP_MAX_PX = 20;

        // Swipe detection: average displacement must exceed this.
        const SWIPE_MIN_PX = 40;

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

                for (const t of e.changedTouches) {
                    _mt.set(t.identifier, {
                        startX: t.clientX, startY: t.clientY,
                        startTime: performance.now(),
                        lastX: t.clientX,  lastY: t.clientY,
                    });
                }

                // If two or more fingers are now down, cancel single-finger throttle.
                if (_mt.size >= 2) {
                    _abortThrottle();
                    return;
                }

                // Single finger — start throttle tracking.
                if (!gameRunning || paused) return;
                if (touchThrottleActive) return;
                const t = e.changedTouches[0];
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

                // Collect the records for fingers that just lifted.
                const lifted = [];
                for (const t of e.changedTouches) {
                    if (_mt.has(t.identifier)) {
                        lifted.push(_mt.get(t.identifier));
                        _mt.delete(t.identifier);
                    }
                }

                // Fire multi-touch gesture when ALL fingers from a group have lifted.
                // We trigger when the map empties after having had ≥2 touches, using
                // the snapshot of lifted touches (which includes all fingers from this
                // gesture since they typically lift together or within one event).
                if (_mt.size === 0 && lifted.length >= 2) {
                    _handleMultiGesture(lifted);
                }

                // Single-finger throttle / flick resolution.
                for (const t of e.changedTouches) {
                    if (t.identifier !== _touchThrottleId) continue;
                    touchThrottleActive = false;
                    _touchThrottleId = -1;

                    if (!controlsOptions.tiltEnabled) {
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
                for (const t of e.changedTouches) _mt.delete(t.identifier);
                touchThrottleActive = false;
                _touchThrottleId = -1;
            }, { passive: false });
        })();

        // Screen Wake Lock — keep mobile devices from auto-locking / dimming while a
        // run is in progress. The lock is a no-op on unsupported browsers (older iOS,
        // desktop without the API). The OS auto-releases the sentinel whenever the page
        // is hidden (tab switch, screen lock), so we re-request it on visibilitychange
        // when we come back to a live, unpaused run. Acquire on run start / resume,
        // release on pause / game over.
        let wakeLockSentinel = null;
        async function requestWakeLock() {
            if (!('wakeLock' in navigator)) return;
            if (wakeLockSentinel) return;
            try {
                wakeLockSentinel = await navigator.wakeLock.request('screen');
                // The sentinel can be released by the OS; drop our ref so the next
                // request re-acquires rather than short-circuiting on a dead lock.
                wakeLockSentinel.addEventListener('release', () => {
                    wakeLockSentinel = null;
                });
            } catch (e) {
                // Request can reject (page not visible, OS policy). Stay silent —
                // the game is fully playable without the lock.
                wakeLockSentinel = null;
            }
        }
        function releaseWakeLock() {
            if (!wakeLockSentinel) return;
            const s = wakeLockSentinel;
            wakeLockSentinel = null;
            s.release().catch(() => {});
        }

        function formatRunTime(seconds) {
            const s = Math.max(0, Math.floor(seconds));
            const m = Math.floor(s / 60);
            const rem = s % 60;
            return `${m}:${rem.toString().padStart(2, '0')}`;
        }

        // Smoothly fade both audio channels (engine/cues on `default`, obstacle/gas/wrench
        // on `props`) to silence over `seconds`, then call `done`. Ramping the output
        // gains rather than stopping individual synths keeps the persistent engine
        // synth from popping when killed and lets every queued burst tail out naturally.
        function fadeAudioOut(seconds, done) {
            const t0 = syngen.context().currentTime;
            const t1 = t0 + seconds;
            [audioChannels.default.output.gain, audioChannels.props.output.gain, audioChannels.groundProps.output.gain].forEach((g) => {
                g.cancelScheduledValues(t0);
                g.setValueAtTime(g.value, t0);
                g.linearRampToValueAtTime(0, t1);
            });
            setTimeout(done, seconds * 1000 + 30);
        }

        // Smoothly ramp both channel output gains to `target` (number, or null for baseGain)
        // over `seconds`. Used by pause/resume so existing game sounds tail out/in instead
        // of being cut. The pause sound bypasses these gains by connecting straight to
        // ac.destination so it stays audible across the fade.
        function fadeAudioChannelsTo(target, seconds) {
            const t0 = syngen.context().currentTime;
            const t1 = t0 + seconds;
            [audioChannels.default, audioChannels.props, audioChannels.groundProps].forEach((ch) => {
                const g = ch.output.gain;
                const dest = target === null ? ch.baseGain : target;
                g.cancelScheduledValues(t0);
                g.setValueAtTime(g.value, t0);
                g.linearRampToValueAtTime(dest, t1);
            });
        }

        // Triangle-wave pentatonic arpeggio played at both pause and resume.
        // C pentatonic major (C D E G A) then up a fifth into G pentatonic major
        // (G A B D E) — ten notes across ~300 ms.
        const PAUSE_ARP_NOTES = [
            523.25, 587.33, 659.25, 783.99, 880.00,
            783.99, 880.00, 987.77, 1174.66, 1318.51,
        ];
        function playPauseSound() {
            const ac = syngen.context();
            const now = ac.currentTime + 0.005;
            const total = 0.30;
            const noteDur = total / PAUSE_ARP_NOTES.length;
            const osc = ac.createOscillator();
            osc.type = 'triangle';
            const g = ac.createGain();
            g.gain.value = 0;
            osc.connect(g).connect(ac.destination);
            const peak = syngen.fn.fromDb(-10);
            const tail = syngen.fn.fromDb(-22);
            for (let i = 0; i < PAUSE_ARP_NOTES.length; i++) {
                const t = now + i * noteDur;
                osc.frequency.setValueAtTime(PAUSE_ARP_NOTES[i], t);
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(peak, t + noteDur * 0.2);
                g.gain.linearRampToValueAtTime(tail, t + noteDur * 0.95);
            }
            const end = now + total;
            g.gain.setValueAtTime(0, end);
            osc.start(now);
            osc.stop(end + 0.05);
        }

        function pauseGame() {
            if (!gameRunning || paused) return;
            paused = true;
            throttleHeld = 0;
            throttleAnalog = 0;
            laneHeld = 0;
            keyLaneHeldDir = 0;
            stopHorn();
            rumble.stopAll();
            playPauseSound();
            fadeAudioChannelsTo(0, 0.15);
            releaseWakeLock();
            startBtn.textContent = "Resume Game";
            announce("Simulator paused.");
        }

        function resumeGame() {
            if (!gameRunning || !paused) return;
            paused = false;
            // A screen-lock pause leaves iOS's AudioContext suspended; unlike a
            // button pause (where the context keeps running) it stays suspended
            // after unlock, killing all audio while leaving TTS — a separate
            // subsystem — working. Resume is always driven by a user gesture
            // (button/binding/tap), which is exactly what iOS requires to
            // un-suspend, so resume the context here. Harmless when not suspended.
            syngen.context().resume();
            playPauseSound();
            fadeAudioChannelsTo(null, 0.15);
            requestWakeLock();
            startBtn.textContent = "Pause Game";
            announce("Resumed.");
        }

        function restoreAudioChannelGains() {
            const now = syngen.context().currentTime;
            [audioChannels.default, audioChannels.props, audioChannels.groundProps].forEach((ch) => {
                ch.output.gain.cancelScheduledValues(now);
                ch.output.gain.setValueAtTime(ch.baseGain, now);
            });
        }

        function pct(n, d) {
            if (!d) return '0';
            return (Math.round((n / d) * 1000) / 10).toString();
        }

        function renderStats() {
            const avgSpeed = stats.speedFrames > 0
                ? Math.round(stats.speedSum / stats.speedFrames)
                : 0;
            const totalPU = stats.powerUpsCollected;
            const hbFired = stats.hornBallsFired;
            const hbHit = stats.hornBallsHit;
            const hbMiss = stats.hornBallsMissed;
            const hbAccPct = (hbHit + hbMiss) > 0 ? pct(hbHit, hbHit + hbMiss) : '0';
            const rHit = stats.rampsHit;
            const rMiss = stats.rampsMissed;
            const rAccPct = (rHit + rMiss) > 0 ? pct(rHit, rHit + rMiss) : '0';
            const airSecs = stats.totalAirTime.toFixed(1);

            const lines = [];
            lines.push(`Average speed: ${avgSpeed} mph.`);
            lines.push(`Obstacles avoided: ${stats.obstaclesAvoided}.`);
            lines.push(`Near misses: ${stats.nearMisses}.`);
            lines.push(`Crashes: ${stats.crashes}.`);
            lines.push(`Gas tanks collected: ${stats.gasCansCollected}.`);
            lines.push(`Wrenches collected: ${stats.wrenchesCollected}.`);
            lines.push(`Total power-ups collected: ${totalPU}.`);
            if (totalPU > 0) {
                lines.push(
                    `Power-up breakdown: Shield ${pct(stats.powerUpsByType.shield, totalPU)}%, `
                    + `Rocket ${pct(stats.powerUpsByType.rocket, totalPU)}%, `
                    + `Horn ball ${pct(stats.powerUpsByType.hornBall, totalPU)}%.`
                );
            } else {
                lines.push(`Power-up breakdown: none collected.`);
            }
            lines.push(
                `Fired ${hbFired} horn balls, hitting ${hbHit} and missing ${hbMiss}, `
                + `for an accuracy of ${hbAccPct}%.`
            );
            lines.push(`Obstacles blocked by shield: ${stats.shieldsAbsorbed}.`);
            lines.push(`Sink holes traversed: ${stats.sinkholesTraversed}.`);
            lines.push(
                `Hit ${rHit} ramps and missed ${rMiss}, for an accuracy of ${rAccPct}%.`
            );
            lines.push(`Total air time: ${airSecs} seconds.`);
            lines.push(`Coins collected: ${stats.coinsCollected}.`);
            const longestRocket = stats.rocketDurations.length > 0
                ? Math.max(...stats.rocketDurations)
                : 0;
            lines.push(`Longest rocket run: ${longestRocket.toFixed(1)} seconds.`);

            statsList.innerHTML = '';
            for (const text of lines) {
                const li = document.createElement('li');
                li.textContent = text;
                statsList.appendChild(li);
            }
        }

        statsToggle.addEventListener('click', () => {
            const expanded = statsToggle.getAttribute('aria-expanded') === 'true';
            const next = !expanded;
            statsToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
            statsToggle.textContent = next ? 'Hide Statistics' : 'Show Statistics';
            statsPanel.hidden = !next;
        });

        function resetStatsPanel() {
            statsToggle.setAttribute('aria-expanded', 'false');
            statsToggle.textContent = 'Show Statistics';
            statsPanel.hidden = true;
        }

        function gameOver(reason = '') {
            gameRunning = false;
            speed = 0;
            targetSpeed = 0;
            laneHeld = 0;
            keyLaneHeldDir = 0;
            releaseWakeLock();
            stopHorn();
            rumble.stopAll();
            destroyRocketWind();
            clearTunnel();
            activePowerUp = null;
            const runtimeStr = formatRunTime((Date.now() - gameStartTime) / 1000);
            goScoreEl.textContent = score;
            goTimeEl.textContent = runtimeStr;
            if (reason) {
                goReasonEl.textContent = reason;
                goReasonEl.style.display = 'block';
            } else {
                goReasonEl.style.display = 'none';
            }
            renderStats();
            resetStatsPanel();
            gameOverEl.style.display = 'block';
            startBtn.style.display = 'none';
            const reasonPhrase = reason ? ` ${reason}` : '';
            announce(`Game over.${reasonPhrase} Final score ${score}. Run time ${runtimeStr}.`);
            restartBtn.focus();
            fadeAudioOut(0.5, () => {
                // If the player hit Play Again during the 0.5 s fade, beginRun has
                // already started a fresh run (gameRunning === true) and re-spawned
                // the world. Running this stale teardown now would destroy those
                // freshly-spawned props + the CPU opponent's engine drone a fraction
                // of a second into the new game — audio dropping out for no reason.
                if (gameRunning) return;
                clearObstacle();
                clearObstacle2();
                clearGasCan();
                clearWrench();
                clearPowerUpPickup();
                clearCoin();
                clearProjectile();
                clearSinkhole();
                clearRamp();
                clearAirCoin();
                resetCpuRaceState();
                jumping = false;
            });
        }

        function startGame() {
            // Ignore a second Start press while the tilt permission/calibration
            // hand-off from a previous press is still in flight.
            if (tiltStartPending) return;

            syngen.context().resume();
            if (ttsOptions && ttsOptions.enabled) ttsSpeakRaw('Begin');
            const audioSession = syngen.context().audioSession;
            if (audioSession) audioSession.type = 'playback';
            canvas.focus();
            if (!engineSynth) buildEngine();

            // Tilt steering: this Start click is a user gesture, so re-request
            // sensor permission here too — iOS does not reliably persist the
            // grant across sessions, and a cached load may have restored
            // tiltEnabled=true without a live permission. We defer the actual run
            // start until the OS prompt is answered AND the orientation cue has
            // captured neutral, so the game never begins under the player's feet.
            if (controlsOptions.tiltEnabled) {
                tiltActive = false;
                tiltNeutral = null;
                tiltCalibratePending = true;
                tiltStartPending = true;
                ensureTiltPermission().then((ok) => {
                    if (ok) {
                        attachTiltListener();
                        // Orienting the phone is finicky (the player often kills
                        // the screen reader and levels it by feel). Play the
                        // countdown cue and begin the run only once its final
                        // chime reads the sensor ~2 s from now.
                        startTiltCalibrationCue(beginRun);
                    } else {
                        // The OS won't grant the sensor. Keep the preference so the
                        // next Start retries, surface the notice in Options, and
                        // tell the player — then start straight away on flick
                        // steering (no sensor to calibrate).
                        if (tiltUnavailableEl) tiltUnavailableEl.style.display = 'block';
                        announce('Tilt steering unavailable');
                        tiltCalibratePending = false;
                        beginRun();
                    }
                });
                return;
            }

            beginRun();
        }

        function beginRun() {
            tiltStartPending = false;
            gameRunning = true;
            targetSpeed = 0;
            speed = 0;
            score = 0;
            lane = 1;
            health = HEALTH_MAX;
            nextMisfireAt = 0;
            nextBackfireAt = 0;
            backfireActiveUntil = 0;
            accelHoldUntil = 0;
            clearEngineDamageTimers();
            if (misfireGate) {
                const now = syngen.time();
                misfireGate.gain.cancelScheduledValues(now);
                misfireGate.gain.setValueAtTime(1, now);
            }
            // Snap the engine voice back to its clean idle baseline. At game over
            // the frame loop stops, freezing whatever damaged values the dying run
            // last wrote — a high FM mod depth (growl/grit) and a clamped-down
            // filter cutoff. setTargetAtTime never expires, so without this the new
            // run inherits that frozen automation and only eases back to clean over
            // ~0.5 s, leaving the engine's growl/body sounding wrong at full health
            // right after a restart. cancelScheduledValues + setValueAtTime drops the
            // stale automation and starts clean; updateEngineAudio takes over next frame.
            // (cancelScheduledValues only clears the param's own events, not the
            // permanently-connected drift LFOs, so the wander survives.)
            if (engineSynth) {
                const now = syngen.time();
                engineSynth.param.frequency.cancelScheduledValues(now);
                engineSynth.param.frequency.setValueAtTime(ENGINE_FREQ_MIN, now);
                engineSynth.param.mod.frequency.cancelScheduledValues(now);
                engineSynth.param.mod.frequency.setValueAtTime(ENGINE_FREQ_MIN * 0.5, now);
                engineSynth.param.mod.depth.cancelScheduledValues(now);
                engineSynth.param.mod.depth.setValueAtTime(ENGINE_MOD_DEPTH_MIN, now);
                if (engineSynth.filter) {
                    engineSynth.filter.frequency.cancelScheduledValues(now);
                    engineSynth.filter.frequency.setValueAtTime(ENGINE_FILTER_MIN, now);
                }
            }
            // Landing-load roughness state isn't otherwise reset; a game over mid-
            // touchdown would carry landingLoadActive/landingDeficit into the new run.
            landingLoadActive = false;
            landingDeficit = 0;
            gameStartTime = Date.now();
            seedRng(gameStartTime ^ Math.floor(performance.now() * 1000));
            lastThrottleBucket = 0;
            lastSpeedBucket = 0;
            gear = 1;
            shifting = false;
            shiftElapsed = 0;
            fuel = FUEL_MAX;
            outOfFuelAnnounced = false;
            clearObstacle();
            clearObstacle2();
            clearGasCan();
            clearWrench();
            clearPowerUpPickup();
            clearCoin();
            clearProjectile();
            clearSinkhole();
            clearRamp();
            clearAirCoin();
            clearTunnel();
            nextTunnelScoreThreshold = TUNNEL_SCORE_INTERVAL;
            jumping = false;
            rampEverSpawned = false;
            destroyRocketWind();
            powerUpQueue.length = 0;
            activePowerUp = null;
            powerUpScoreCeiling = 0;
            highSpeedSeconds = 0;
            shieldCount = 0;
            streak.count = 0;
            streak.multiplier = 1;
            streak.nextHitNoteHz = STREAK_BASE_HZ;
            streak.expiresAt = 0;
            nearMissStreak = 0;
            resetStats();
            paused = false;
            laneHeld = 0;
            keyLaneHeldDir = 0;
            lastPadStickDir = 0;
            rumble.stopAll();
            restoreAudioChannelGains();
            // Build the perlin-noise-driven map ahead of the player. Replaces
            // every per-entity schedule*Spawn call that lived here before.
            initWorldGen();
            resetCpuRaceState();
            gameOverEl.style.display = 'none';
            startBtn.style.display = 'inline-block';
            startBtn.textContent = "Pause Game";
            requestWakeLock();
        }

        restartBtn.addEventListener('click', startGame);

        startBtn.addEventListener('click', () => {
            if (!gameRunning) {
                startGame();
            } else if (paused) {
                resumeGame();
            } else {
                pauseGame();
            }
        });

        // Click / tap / Enter on the canvas starts the game when it hasn't run
        // yet, mirroring the Start button. Once a game is running, the canvas
        // is inert here so taps/Enter fall through to the gameplay controls.
        canvas.addEventListener('click', () => {
            if (!gameRunning) startGame();
        });
        canvas.addEventListener('keydown', (e) => {
            if (!gameRunning && e.key === 'Enter') {
                e.preventDefault();
                startGame();
            }
        });

        // Pause the run when the page is hidden — the device locking its screen,
        // the player switching apps/tabs, etc. On iOS the game otherwise keeps
        // running (and burning fuel) behind a locked screen, so the player comes
        // back to a crashed or dead run. visibilitychange fires for screen lock,
        // app switch, and tab switch on every modern browser. When we return to a
        // live, unpaused run, re-request the wake lock the OS dropped while hidden.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (gameRunning && !paused) pauseGame();
            } else {
                if (gameRunning && !paused) requestWakeLock();
            }
        });

        // Boot syngen's loop once. Game logic gates itself on `gameRunning`.
        syngen.loop.start();
        draw();

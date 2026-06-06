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
            startBtn.textContent = "Resume Game";
            announce("Simulator paused.");
        }

        function resumeGame() {
            if (!gameRunning || !paused) return;
            paused = false;
            playPauseSound();
            fadeAudioChannelsTo(null, 0.15);
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
                clearObstacle();
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
            syngen.context().resume();
            if (ttsOptions && ttsOptions.enabled) ttsSpeakRaw('Begin');
            const audioSession = syngen.context().audioSession;
            if (audioSession) audioSession.type = 'playback';
            canvas.focus();
            if (!engineSynth) buildEngine();

            // Tilt steering: this Start click is a user gesture, so re-request
            // sensor permission here too — iOS does not reliably persist the
            // grant across sessions, and a cached load may have restored
            // tiltEnabled=true without a live permission. Recalibrate neutral to
            // however the phone is being held right now.
            if (controlsOptions.tiltEnabled) {
                ensureTiltPermission().then((ok) => {
                    if (ok) { attachTiltListener(); calibrateTilt(); }
                });
            }

            gameRunning = true;
            targetSpeed = 0;
            speed = 0;
            score = 0;
            lane = 1;
            health = HEALTH_MAX;
            nextMisfireAt = 0;
            nextBackfireAt = 0;
            backfireActiveUntil = 0;
            if (misfireGate) {
                const now = syngen.time();
                misfireGate.gain.cancelScheduledValues(now);
                misfireGate.gain.setValueAtTime(1, now);
            }
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
            announce("Bat Out Of Hell engaged. Full tank. Full health.");
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

        // Boot syngen's loop once. Game logic gates itself on `gameRunning`.
        syngen.loop.start();
        draw();

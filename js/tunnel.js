        // ===== Tunnel =====
        // All-lane zones with no hazards, staggered coins, and boosted reverb.
        // World generator places candidates; materialization applies score gate + dice roll.
        // Per-frame logic lives in loop.js (tunnel tick + coin block).

        // 30s at 150mph: 30 * (150/100) * 90 = 4050 units
        const TUNNEL_LENGTH_MAX = 4050;
        const TUNNEL_LENGTH_MIN = 2025;   // ~15s at 150mph
        const TUNNEL_SCORE_INTERVAL = 5000;
        const TUNNEL_SPAWN_CHANCE = 0.45;
        const TUNNEL_SPAWN_DISTANCE = 200;
        const TUNNEL_DESPAWN_TAIL = 200;
        const TUNNEL_ENGINE_REVERB_IN_DB = -3;
        const TUNNEL_HORN_REVERB_IN_DB = -6.5;
        const TUNNEL_WHOOSH_DURATION = 0.4;
        const TUNNEL_WHOOSH_FREQ_HIGH = 8000;
        const TUNNEL_WHOOSH_FREQ_LOW = 200;
        const TUNNEL_WHOOSH_PEAK_DB = -6;
        const TUNNEL_ENGINE_REVERB_OUT_DB = -18;
        const TUNNEL_ENGINE_REVERB_RAMP = 0.1;    // seconds
        // Master wet level of the parallel tunnel reverb bus while inside a
        // tunnel. Linear (not dB) because it's a direct GainNode value; the
        // per-source send gains baked in engine.js / channel routing already
        // set the relative mix. Ramp times are deliberately a few hundred ms
        // so the long-tail bloom feels like walking into the space rather
        // than snapping on.
        const TUNNEL_WET_OPEN = 1.0;
        const TUNNEL_WET_RAMP_IN = 0.3;
        const TUNNEL_WET_RAMP_OUT = 0.5;
        const TUNNEL_COIN_GAP_MIN = 0.5;
        const TUNNEL_COIN_GAP_MAX = 1.0;
        const TUNNEL_ROCKET_CHANCE_MULT = 3.0;
        const TUNNEL_POWERUP_INTERVAL_MIN = 5;
        const TUNNEL_POWERUP_INTERVAL_MAX = 12;

        let nextTunnelScoreThreshold = TUNNEL_SCORE_INTERVAL;
        // Wall-clock time (syngen.time()) when the player last exited a tunnel.
        // Used by the world generator to enforce a 180 s cooldown between tunnels.
        let tunnelExitTime = -Infinity;

        const tunnel = {
            active: false,
            entered: false,
            cleared: false,
            frontDistance: 0,
            length: 0,
            ambience: null,
            nextCoinLane: 0,
            nextPowerUpAt: 0,
        };

        // Low-pass filtered noise — road resonance inside the tunnel walls.
        function makeTunnelAmbience() {
            const ac = syngen.context();
            const bus = audioChannels.default.createBus('tunnelAmbience');
            const src = ac.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            src.loop = true;
            const hp = ac.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 60;
            const lp = ac.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 360;
            lp.Q.value = 0.7;
            const env = ac.createGain();
            env.gain.value = 0;
            src.connect(hp).connect(lp).connect(env).connect(bus);
            env.connect(reverb.createSend(-20));
            src.start();
            return {
                gain: env.gain,
                destroy() {
                    const now = ac.currentTime;
                    env.gain.cancelScheduledValues(now);
                    env.gain.setValueAtTime(env.gain.value, now);
                    env.gain.linearRampToValueAtTime(0, now + 0.5);
                    setTimeout(() => {
                        try { src.stop(); } catch (e) {}
                        env.disconnect();
                        bus.disconnect();
                    }, 600);
                },
            };
        }

        // Filter-sweep whoosh on tunnel mouth crossings. direction: 'in' sweeps
        // lowpass cutoff high→low (entering darkens); 'out' sweeps low→high.
        function playTunnelWhoosh(direction) {
            const ac = syngen.context();
            const now = ac.currentTime;
            const bus = audioChannels.default.createBus('tunnelWhoosh');
            const src = ac.createBufferSource();
            src.buffer = makeWhiteNoiseBuffer();
            const lp = ac.createBiquadFilter();
            lp.type = 'lowpass';
            lp.Q.value = 1.2;
            const env = ac.createGain();
            env.gain.value = 0;
            src.connect(lp).connect(env).connect(bus);
            const peak = syngen.fn.fromDb(TUNNEL_WHOOSH_PEAK_DB);
            const dur = TUNNEL_WHOOSH_DURATION;
            const fHi = TUNNEL_WHOOSH_FREQ_HIGH;
            const fLo = TUNNEL_WHOOSH_FREQ_LOW;
            const fStart = direction === 'out' ? fLo : fHi;
            const fEnd = direction === 'out' ? fHi : fLo;
            lp.frequency.setValueAtTime(fStart, now);
            lp.frequency.exponentialRampToValueAtTime(fEnd, now + dur);
            env.gain.setValueAtTime(0, now);
            env.gain.linearRampToValueAtTime(peak, now + dur * 0.25);
            env.gain.linearRampToValueAtTime(0, now + dur);
            src.start(now);
            src.stop(now + dur + 0.05);
            setTimeout(() => {
                try { src.disconnect(); } catch (e) {}
                try { lp.disconnect(); } catch (e) {}
                try { env.disconnect(); } catch (e) {}
                try { bus.disconnect(); } catch (e) {}
            }, (dur + 0.2) * 1000);
        }

        function spawnTunnel(dist) {
            if (tunnel.active) return;
            const len = TUNNEL_LENGTH_MIN + rand() * (TUNNEL_LENGTH_MAX - TUNNEL_LENGTH_MIN);
            tunnel.active = true;
            tunnel.entered = false;
            tunnel.cleared = false;
            tunnel.frontDistance = dist;
            tunnel.length = Math.round(len);
            tunnel.ambience = null;
            tunnel.nextCoinLane = 0;
            tunnel.nextPowerUpAt = 0;
            announce(`Tunnel ahead. All lanes open.`, {category: 'items', critical: true});
        }

        function enterTunnel() {
            tunnel.entered = true;
            playTunnelWhoosh('in');
            tunnel.ambience = makeTunnelAmbience();
            const ac = syngen.context();
            const now = ac.currentTime;
            // Fade in tunnel rumble
            tunnel.ambience.gain.cancelScheduledValues(now);
            tunnel.ambience.gain.setValueAtTime(0, now);
            tunnel.ambience.gain.linearRampToValueAtTime(syngen.fn.fromDb(-20), now + 0.4);
            // Open the parallel tunnel-reverb bus. setValueAtTime captures the
            // current value first so a re-entry mid-fade-out doesn't snap.
            {
                const g = tunnelReverb.wet.gain;
                g.cancelScheduledValues(now);
                g.setValueAtTime(g.value, now);
                g.linearRampToValueAtTime(TUNNEL_WET_OPEN, now + TUNNEL_WET_RAMP_IN);
            }
            // Ramp engine reverb up — enclosed walls reflect more of the engine sound
            if (engineReverbSend) {
                const g = engineReverbSend.gain;
                g.cancelScheduledValues(now);
                g.setValueAtTime(g.value, now);
                g.linearRampToValueAtTime(
                    syngen.fn.fromDb(TUNNEL_ENGINE_REVERB_IN_DB),
                    now + TUNNEL_ENGINE_REVERB_RAMP,
                );
            }
            if (hornReverbSend) {
                const g = hornReverbSend.gain;
                g.cancelScheduledValues(now);
                g.setValueAtTime(g.value, now);
                g.linearRampToValueAtTime(
                    syngen.fn.fromDb(TUNNEL_HORN_REVERB_IN_DB),
                    now + TUNNEL_ENGINE_REVERB_RAMP,
                );
            }
            coin.nextSpawnAt = syngen.time() + TUNNEL_COIN_GAP_MIN;
            tunnel.nextPowerUpAt = syngen.time()
                + TUNNEL_POWERUP_INTERVAL_MIN
                + rand() * (TUNNEL_POWERUP_INTERVAL_MAX - TUNNEL_POWERUP_INTERVAL_MIN);
            announce(`Inside tunnel.`, {category: 'items'});
        }

        function exitTunnel() {
            tunnel.cleared = true;
            tunnelExitTime = syngen.time();
            playTunnelWhoosh('out');
            const ac = syngen.context();
            const now = ac.currentTime;
            // Close the tunnel reverb bus. The long tail keeps decaying
            // through the convolver — only the master wet feed mutes, so the
            // remaining ring-out fades naturally as wet hits 0.
            {
                const g = tunnelReverb.wet.gain;
                g.cancelScheduledValues(now);
                g.setValueAtTime(g.value, now);
                g.linearRampToValueAtTime(0, now + TUNNEL_WET_RAMP_OUT);
            }
            // Restore outdoor reverb level
            if (engineReverbSend) {
                const g = engineReverbSend.gain;
                g.cancelScheduledValues(now);
                g.setValueAtTime(g.value, now);
                g.linearRampToValueAtTime(
                    syngen.fn.fromDb(TUNNEL_ENGINE_REVERB_OUT_DB),
                    now + TUNNEL_ENGINE_REVERB_RAMP,
                );
            }
            if (hornReverbSend) {
                const g = hornReverbSend.gain;
                g.cancelScheduledValues(now);
                g.setValueAtTime(g.value, now);
                g.linearRampToValueAtTime(
                    syngen.fn.fromDb(HORN_REVERB_OUT_DB),
                    now + TUNNEL_ENGINE_REVERB_RAMP,
                );
            }
            if (tunnel.ambience) {
                tunnel.ambience.destroy();
                tunnel.ambience = null;
            }
            clearCoin();
            announce(`Tunnel exited.`, {category: 'items'});
        }

        function clearTunnel() {
            // Restore reverb if interrupted mid-tunnel (game over, etc.)
            if (tunnel.entered && !tunnel.cleared) {
                const ac = syngen.context();
                const now = ac.currentTime;
                {
                    const g = tunnelReverb.wet.gain;
                    g.cancelScheduledValues(now);
                    g.setValueAtTime(g.value, now);
                    g.linearRampToValueAtTime(0, now + 0.15);
                }
                if (engineReverbSend) {
                    const g = engineReverbSend.gain;
                    g.cancelScheduledValues(now);
                    g.setValueAtTime(g.value, now);
                    g.linearRampToValueAtTime(syngen.fn.fromDb(TUNNEL_ENGINE_REVERB_OUT_DB), now + 0.15);
                }
                if (hornReverbSend) {
                    const g = hornReverbSend.gain;
                    g.cancelScheduledValues(now);
                    g.setValueAtTime(g.value, now);
                    g.linearRampToValueAtTime(syngen.fn.fromDb(HORN_REVERB_OUT_DB), now + 0.15);
                }
            }
            if (tunnel.ambience) {
                tunnel.ambience.destroy();
                tunnel.ambience = null;
            }
            tunnel.active = false;
            tunnel.entered = false;
            tunnel.cleared = false;
        }

        // Spawn the next tunnel coin on the staggered lane, then advance the lane pointer.
        function spawnTunnelCoin() {
            coin.lane = tunnel.nextCoinLane;
            tunnel.nextCoinLane = (tunnel.nextCoinLane + 1) % 3;
            coin.distance = 100;
            coin.active = true;
            coin.consumed = false;
            if (coin.prop) { coin.prop.destroy(); coin.prop = null; }
            coin.prop = makeCoinSound({y: (smoothedLane - coin.lane) * LANE_SPACING});
            coin.nextCycleAt = syngen.time();
        }

        function scheduleNextTunnelCoinSpawn() {
            coin.nextSpawnAt = syngen.time()
                + TUNNEL_COIN_GAP_MIN
                + rand() * (TUNNEL_COIN_GAP_MAX - TUNNEL_COIN_GAP_MIN);
        }

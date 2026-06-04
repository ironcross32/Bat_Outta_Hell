        // ===== Sound preview buttons (instructions glossary) =====
        // Each function resumes the AudioContext (works before Start is pressed —
        // the button click itself is the required user gesture) and plays one
        // representative sample of that sound through the existing channel layer.

        function previewObstacle() {
            const ctx = syngen.context();
            ctx.resume().then(() => {
                const prop = makeObstacleSound({y: 0});
                const now = ctx.currentTime + 0.02;
                const dur = 1.0;
                // Open filter and set gain to a "close approach" level
                prop.synth.filter.frequency.setValueAtTime(OBSTACLE_FILTER_MAX * 0.55, now);
                prop.synth.param.gain.setValueAtTime(syngen.fn.fromDb(OBSTACLE_GAIN_MAX_DB - 4), now);
                prop.synth.param.gain.setValueAtTime(syngen.fn.fromDb(OBSTACLE_GAIN_MAX_DB - 4), now + dur - 0.18);
                prop.synth.param.gain.linearRampToValueAtTime(syngen.const.zeroGain, now + dur);
                setTimeout(() => prop.destroy(), (dur + 0.15) * 1000);
            });
        }

        function previewGasCan() {
            const ctx = syngen.context();
            ctx.resume().then(() => {
                const prop = makeGasCanSound({y: 0});
                const now = ctx.currentTime + 0.02;
                prop.proxGain.gain.setValueAtTime(syngen.fn.fromDb(GAS_CAN_GAIN_MAX_DB - 3), now);
                let t = now;
                scheduleGasCanBurst(prop, t, GC_BURST_SHORT, false);
                t += GC_BURST_SHORT + GC_BURST_GAP;
                scheduleGasCanBurst(prop, t, GC_BURST_SHORT, false);
                t += GC_BURST_SHORT + GC_BURST_GAP;
                scheduleGasCanBurst(prop, t, GC_BURST_LONG, true);
                setTimeout(() => prop.destroy(), (GC_CYCLE_TOTAL + 0.25) * 1000);
            });
        }

        function previewWrench() {
            const ctx = syngen.context();
            ctx.resume().then(() => {
                const prop = makeWrenchSound({y: 0});
                const now = ctx.currentTime + 0.02;
                prop.proxGain.gain.setValueAtTime(syngen.fn.fromDb(WRENCH_GAIN_MAX_DB - 3), now);
                let t = now;
                for (let i = 0; i < 3; i++) {
                    scheduleWrenchBurst(prop, t, WR_BURST, 1.0);
                    t += WR_BURST + WR_BURST_GAP;
                }
                t += WR_GROUP_GAP - WR_BURST_GAP;
                const group2Mul = syngen.fn.fromDb(WR_GROUP2_DB);
                for (let i = 0; i < 3; i++) {
                    scheduleWrenchBurst(prop, t, WR_BURST, group2Mul);
                    t += WR_BURST + WR_BURST_GAP;
                }
                setTimeout(() => prop.destroy(), (WR_CYCLE_TOTAL + 0.25) * 1000);
            });
        }

        function previewPowerUpExpire() {
            const ctx = syngen.context();
            ctx.resume().then(() => {
                playPowerUpExpire();
            });
        }

        function previewPowerUp(type) {
            const ctx = syngen.context();
            ctx.resume().then(() => {
                const prop = makePowerUpPickupSound(type, {y: 0});
                const now = ctx.currentTime + 0.02;
                prop.proxGain.gain.setValueAtTime(syngen.fn.fromDb(POWERUP_GAIN_MAX_DB - 3), now);
                prop.scheduleCycle(now);
                setTimeout(() => prop.destroy(), (prop.cycleTotal + 0.25) * 1000);
            });
        }


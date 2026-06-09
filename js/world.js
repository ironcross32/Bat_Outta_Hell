        // ===== World generator =====
        // Replaces the old time-based scheduleNext* family with a distance-based
        // map that is pre-generated ~30 s ahead of the player and consumed as the
        // odometer advances. Perlin noise drives the "intensity" of the upcoming
        // stretch and the type/lane selection at each slot, so the player hears
        // coherent dense and calm passages instead of uniformly-random spacing.

        // The hard upper cap on player speed we'll ever generate against. We
        // generate LOOKAHEAD_SECONDS of map at this speed so the horizon is
        // always full even at top throttle. Distance units: 100 mph = 90 u/s.
        const WORLD_MAX_GEN_SPEED = 200;
        const WORLD_LOOKAHEAD_SECONDS = 30;
        // 30 s * 180 u/s = 5400 units. Mirrors `distance -= (speed/100)*90*delta`.
        const WORLD_LOOKAHEAD_UNITS = WORLD_LOOKAHEAD_SECONDS
            * (WORLD_MAX_GEN_SPEED / 100) * 90;
        // Chunks are generated as solid blocks ahead of the player. Smaller =
        // more frequent generator wakeups, larger = chunkier perlin sampling.
        // 600 units = ~6.7 s at 100 mph, ~3.3 s at 200 mph.
        const WORLD_CHUNK_UNITS = 600;
        // Candidate placement grid inside each chunk. Every SLOT_UNITS we
        // consider one event. 50 units ≈ 0.55 s at 100 mph — fine-grained
        // enough to feel organic, coarse enough that adjacent slots can't both
        // fire (MIN_GAP eats the next slot).
        const WORLD_SLOT_UNITS = 75;
        // Minimum gap (in units) between any two consecutive non-sinkhole
        // events. Stops announcements from piling on top of each other. 110
        // units ≈ 1.2 s at 100 mph, ~0.6 s at 200 mph.
        // Base values — difficulty scaling tightens these starting at 10 K score.
        const WORLD_MIN_GAP = 90;
        // Initial cushion in front of the player at run start so the very first
        // hazards aren't right under the bumper before the engine has spooled.
        const WORLD_INITIAL_CLEAR = 750;
        // Sinkhole first-occurrence cushion (units). Player has to actually
        // drive a while before a sinkhole is on the table. Replaces the old
        // 120-second INITIAL_DELAY which often expired never (player dead
        // first) and which the ramp gate kept pushing further into the future.
        const WORLD_SINKHOLE_MIN_AT = 900;
        // Minimum spacing between successive sinkholes, in units. Keeps them
        // a real "event" rather than a recurring chore.
        const WORLD_SINKHOLE_MIN_SPACING = 4500;
        // After placing a sinkhole, reserve at least this much clear road
        // both before and after so the player has lane-change room.
        const WORLD_SINKHOLE_CLEAR_BEFORE = 500;
        const WORLD_SINKHOLE_CLEAR_AFTER = SINKHOLE_ZONE_LENGTH + 250;

        // Spawn distance overrides per event kind. The generator pops an event
        // when (event.at - worldPos) <= the kind's spawn distance, then hands
        // the residual offset to the spawn function as `distance`.
        const WORLD_SPAWN_DIST = {
            obstacle: 100,
            clusterPartner: 100,
            gasCan: 100,
            wrench: 100,
            ramp: 100,
            powerUp: 100,
            sinkhole: SINKHOLE_SPAWN_DISTANCE, // 200
            tunnel: TUNNEL_SPAWN_DISTANCE,      // 200
        };

        // Perlin wavelengths. The intensity curve breathes slowest (long
        // calm/busy arcs); type and lane churn faster so the *flavour* of a
        // busy stretch still varies. value() expects coordinates near
        // integer steps, so we feed it `units / wavelength`. Wavelengths are
        // intentionally short enough that a single run sees many cycles —
        // longer ones risk the whole game sitting in one perlin trough.
        const WORLD_INTENSITY_WAVELENGTH = 900;   // ~10 s at 100 mph
        const WORLD_TYPE_WAVELENGTH = 500;        // ~5.5 s at 100 mph
        const WORLD_LANE_WAVELENGTH = 350;        // ~3.9 s at 100 mph — gentle drift
        const WORLD_SINKHOLE_WAVELENGTH = 4000;   // ~44 s at 100 mph

        // Tunnel generator knobs. Tunnels are rare (large min spacing) and require
        // a score milestone + 1-in-4 dice roll to actually materialize.
        const WORLD_TUNNEL_WAVELENGTH = 1500;
        const WORLD_TUNNEL_THRESHOLD = 0.55;
        const WORLD_TUNNEL_MIN_AT = 900;
        // 4000 units ≈ 44 s at 100 mph.
        const WORLD_TUNNEL_MIN_SPACING = 4000;
        const WORLD_TUNNEL_CLEAR_BEFORE = 150;
        // Reserve the full max-length tunnel plus a buffer on both sides.
        const WORLD_TUNNEL_CLEAR_AFTER = TUNNEL_LENGTH_MAX + 400;
        // Steady-metronome pacing. Perlin intensity no longer gates yes/no —
        // it modulates the *gap* between events. Dense passages fire near
        // WORLD_DENSE_GAP, calm passages stretch toward WORLD_SPARSE_GAP, and
        // WORLD_MAX_GAP_PITY is a belt-and-suspenders ceiling. The audio-only
        // UX needs predictable cadence more than perlin's natural silences.
        // DENSE just above WORLD_MIN_GAP so the min-gap floor stays effective.
        // All four values are base lines; difficulty scaling (see worldEffective*
        // helpers below) tightens them as score climbs past 10 K milestones.
        const WORLD_DENSE_GAP = 110;   // ~1.2 s @ 100 mph, ~0.6 s @ 200 mph
        const WORLD_SPARSE_GAP = 280;  // ~3.1 s @ 100 mph, ~1.6 s @ 200 mph
        const WORLD_MAX_GAP_PITY = 350;

        // ── Score-based difficulty scaling ────────────────────────────────────
        // Every 10 K points beyond the first 10 K adds one tier. Gaps shrink
        // per tier (floors prevent them from going unreasonably tight). Clusters
        // become possible at tier 1 and grow more frequent with each tier.
        //   Tier 0 (<10 K)  : vanilla settings, no clusters
        //   Tier 1 (10 K)   : slight gap reduction, 10 % cluster chance
        //   Tier 5 (50 K)   : moderate density, 50 % cluster chance
        //   Tier 10 (100 K+): floors reached — densest possible, 60 % clusters
        function difficultyTier() {
            return Math.min(10, Math.floor(score / 10000));
        }
        function worldEffectiveMinGap() {
            return Math.max(60, WORLD_MIN_GAP - difficultyTier() * 3);
        }
        function worldEffectiveDenseGap() {
            return Math.max(75, WORLD_DENSE_GAP - difficultyTier() * 5);
        }
        function worldEffectiveSparseGap() {
            return Math.max(150, WORLD_SPARSE_GAP - difficultyTier() * 13);
        }
        function worldEffectiveMaxGapPity() {
            return Math.max(175, WORLD_MAX_GAP_PITY - difficultyTier() * 17);
        }

        // ── Obstacle cluster knobs ────────────────────────────────────────────
        // Clusters are pairs of obstacles spawned close together: side-by-side
        // (same forward position, different lanes — one escape lane left open) or
        // slalom (staggered, alternating lanes — player must weave through both).
        // Cluster partners use the obstacle2 slot; only one cluster can be live
        // at a time (obstacle2.active gates the materialize path).
        const CLUSTER_CHANCE_PER_TIER = 0.1;    // 10 % per tier above tier 0
        const CLUSTER_CHANCE_MAX = 0.6;          // hard cap at 60 %
        const CLUSTER_SIDE_BY_SIDE_CHANCE = 0.4; // 40 % of clusters are side-by-side
        const CLUSTER_STAGGER_MIN = 40;          // units between slalom pair members
        const CLUSTER_STAGGER_MAX = 80;          // (randomised inside this range)
        // Sinkholes require this much above the WORLD_SINKHOLE_WAVELENGTH
        // perlin curve AND all the spacing/cushion gates.
        const WORLD_SINKHOLE_THRESHOLD = 0.72;

        // Anti-cluster window for gas cans and ramps. If a second gas can (or
        // ramp) tries to materialize within this many units of the previous
        // one, we coin-flip: 50% drop the slot, 50% convert it into an
        // obstacle. 900 units ≈ 10 s at 100 mph, ~5 s at 200 mph. Strategy
        // matters more when fuel/jump pickups are paced out instead of
        // arriving in unmissable clumps.
        const WORLD_CLUSTER_WINDOW_UNITS = 900;

        // During an active rocket run, a fraction of would-be rocket-extension
        // pickups are dropped to an obstacle instead, thinning extension spawns
        // by ~10% so they don't cluster 5-6 deep. (No gas cans spawn mid-rocket.)
        const ROCKET_PICKUP_SKIP_CHANCE = 0.1;

        // Challenge-mode boosters: every world slot would otherwise become a
        // booster (DENSE_GAP ≈ 1.2 s @ 100 mph), which feels relentless. Drop
        // any slot whose distance from the last booster is below this gap so
        // they stay common but breathable. ~5.5 s @ 100 mph.
        const WORLD_BOOSTER_MIN_SPACING = 500;

        let worldPos = 0;
        let worldGeneratedThrough = 0;
        // Sorted ascending by .at. Each entry: {kind, at, lane?}.
        const worldEvents = [];
        let worldLastEventAt = -Infinity;
        let worldLastSinkholeAt = -Infinity;
        let worldLastGasCanAt = -Infinity;
        let worldLastRampAt = -Infinity;
        let worldLastWrenchAt = -Infinity;
        let worldLastTunnelAt = -Infinity;
        let worldLastBoosterAt = -Infinity;
        // Hazard-clear cursor that survives across chunks. When a tunnel or
        // sinkhole is queued, its reserved tail can run 4000+ units long —
        // well past a single 600-unit chunk — so a local `p = zoneEnd; continue;`
        // only protects slots inside the same chunk. Subsequent chunks start
        // fresh and would otherwise pile obstacles into the middle of the
        // tunnel. Setting this to the zone end makes the loop skip every slot
        // before it, regardless of which chunk it lives in.
        let worldClearUntil = 0;

        let worldIntensityNoise = null;
        let worldTypeNoise = null;
        let worldLaneNoise = null;
        let worldSinkholeNoise = null;
        let worldTunnelNoise = null;

        function initWorldGen() {
            worldPos = 0;
            worldGeneratedThrough = WORLD_INITIAL_CLEAR;
            worldEvents.length = 0;
            worldLastEventAt = -Infinity;
            worldLastSinkholeAt = -Infinity;
            worldLastGasCanAt = -Infinity;
            worldLastRampAt = -Infinity;
            worldLastWrenchAt = -Infinity;
            worldLastTunnelAt = -Infinity;
            worldLastBoosterAt = -Infinity;
            worldClearUntil = 0;
            tunnelExitTime = -Infinity;
            // Seed using the existing per-run gameStartTime so runs aren't
            // identical, but a given run is reproducible from its seed.
            const s = String(gameStartTime);
            worldIntensityNoise = syngen.tool.noise.create('boh-intensity', s);
            worldTypeNoise = syngen.tool.noise.create('boh-type', s);
            worldLaneNoise = syngen.tool.noise.create('boh-lane', s);
            worldSinkholeNoise = syngen.tool.noise.create('boh-sinkhole', s);
            worldTunnelNoise = syngen.tool.noise.create('boh-tunnel', s);
            // Generate enough horizon to cover the player from frame one.
            generateWorldUpTo(WORLD_LOOKAHEAD_UNITS);
        }

        // Map a typeRoll in [0,1) to one of the chunk-system event kinds.
        // Distribution roughly: obstacle 42%, gas can 13%, ramp 11%,
        // power-up pickup 18%, wrench 16%. Wrench/power-up may be skipped
        // at materialization time (state gates), in which case the slot is
        // silently empty — that's expected. Note: perlin clusters values
        // around 0.5, so middle-band slices fire a bit more than their
        // nominal width and tail slices a bit less.
        function worldKindFromRoll(roll) {
            if (roll < 0.42) return 'obstacle';
            if (roll < 0.55) return 'gasCan';
            if (roll < 0.66) return 'ramp';
            if (roll < 0.84) return 'powerUp';
            return 'wrench';
        }

        function worldLaneFromRoll(roll) {
            // Three lanes, split [0, 1/3), [1/3, 2/3), [2/3, 1].
            if (roll < 1 / 3) return 0;
            if (roll < 2 / 3) return 1;
            return 2;
        }

        // Pick a cluster partner lane that differs from the primary lane.
        function worldClusterPartnerLane(primaryLane) {
            const others = [0, 1, 2].filter(l => l !== primaryLane);
            return others[Math.floor(rand() * others.length)];
        }

        // Walk every slot inside [from, to) once and append placements.
        function generateChunk(from, to) {
            for (let p = from; p < to; p += WORLD_SLOT_UNITS) {
                // Skip any slot that lives inside a previously-reserved
                // hazard zone (tunnel or sinkhole tail). The reservation can
                // span many chunks, so this gate has to be checked every slot
                // rather than once at zone-place time.
                if (p < worldClearUntil) continue;
                // Tunnel consideration first — longest reserved zone. Score gate +
                // dice roll evaluated HERE (not at materialization) so a queued
                // candidate is committed to spawn; otherwise the reservation would
                // block the metronome for ~4450 units with nothing on the road.
                // Score is the gen-time score (may be lower than materialize-time);
                // that's intentionally conservative.
                if (!tunnel.active
                        && p >= WORLD_TUNNEL_MIN_AT
                        && p - worldLastTunnelAt >= WORLD_TUNNEL_MIN_SPACING
                        && p - worldLastEventAt >= WORLD_TUNNEL_CLEAR_BEFORE
                        && score >= nextTunnelScoreThreshold
                        && syngen.time() - tunnelExitTime >= 180) {
                    const tv = worldTunnelNoise.value(p / WORLD_TUNNEL_WAVELENGTH);
                    if (tv > WORLD_TUNNEL_THRESHOLD) {
                        nextTunnelScoreThreshold += TUNNEL_SCORE_INTERVAL;
                        if (rand() < TUNNEL_SPAWN_CHANCE) {
                            worldEvents.push({kind: 'tunnel', at: p});
                            worldLastTunnelAt = p;
                            // Reserve the tunnel zone across chunks; don't
                            // poison worldLastEventAt (metronome resumes right
                            // after the zone).
                            const zoneEnd = p + WORLD_TUNNEL_CLEAR_AFTER;
                            if (zoneEnd > worldClearUntil) worldClearUntil = zoneEnd;
                            p = zoneEnd - WORLD_SLOT_UNITS;
                            continue;
                        }
                    }
                }

                // Sinkhole consideration — reserve the zone locally, don't pin
                // the metronome clock. If sinkhole materialization later fails
                // (rare: obstacle.active collision), the metronome still resumes
                // promptly after the reserved tail. Suppressed during challenges
                // so zone reservations don't block booster generation.
                if (!challengeState.active
                        && p >= WORLD_SINKHOLE_MIN_AT
                        && p - worldLastSinkholeAt >= WORLD_SINKHOLE_MIN_SPACING
                        && p - worldLastEventAt >= WORLD_SINKHOLE_CLEAR_BEFORE) {
                    const sh = worldSinkholeNoise.value(p / WORLD_SINKHOLE_WAVELENGTH);
                    if (sh > WORLD_SINKHOLE_THRESHOLD) {
                        worldEvents.push({kind: 'sinkhole', at: p});
                        worldLastSinkholeAt = p;
                        const zoneEnd = p + WORLD_SINKHOLE_CLEAR_AFTER;
                        if (zoneEnd > worldClearUntil) worldClearUntil = zoneEnd;
                        p = zoneEnd - WORLD_SLOT_UNITS;
                        continue;
                    }
                }

                if (p - worldLastEventAt < worldEffectiveMinGap()) continue;

                // Perlin intensity (normalize from ~[-1,1] to [0,1]) sets gap
                // length: high intensity → tight DENSE_GAP, low → loose
                // SPARSE_GAP. Pity cap keeps the worst case bounded.
                // All three thresholds shrink with difficulty tier.
                const intensity = worldIntensityNoise.value(p / WORLD_INTENSITY_WAVELENGTH);
                const intensity01 = Math.max(0, Math.min(1, (intensity + 1) / 2));
                const denseGap = worldEffectiveDenseGap();
                const sparseGap = worldEffectiveSparseGap();
                const gap = denseGap + (sparseGap - denseGap) * (1 - intensity01);
                const effectiveGap = Math.min(gap, worldEffectiveMaxGapPity());
                if (p - worldLastEventAt < effectiveGap) continue;

                const typeRoll = worldTypeNoise.value(p / WORLD_TYPE_WAVELENGTH);
                const laneRoll = worldLaneNoise.value(p / WORLD_LANE_WAVELENGTH);
                const kind = worldKindFromRoll(typeRoll);
                const evtLane = worldLaneFromRoll(laneRoll);

                worldEvents.push({kind, at: p, lane: evtLane});
                worldLastEventAt = p;

                // Cluster injection: obstacle slots at tier 1+ may spawn a
                // partner on a different lane. Partners are injected directly
                // into worldEvents (bypassing the gap metronome) and use the
                // obstacle2 slot at materialize time via the 'clusterPartner'
                // kind. worldEvents remains sorted because partner .at values
                // (p or p+stagger) are smaller than the next regular slot at
                // p + WORLD_SLOT_UNITS.
                if (kind === 'obstacle') {
                    const tier = difficultyTier();
                    if (tier >= 1) {
                        const cChance = Math.min(CLUSTER_CHANCE_MAX, tier * CLUSTER_CHANCE_PER_TIER);
                        if (rand() < cChance) {
                            const partnerLane = worldClusterPartnerLane(evtLane);
                            if (rand() < CLUSTER_SIDE_BY_SIDE_CHANCE) {
                                // Side-by-side: same forward position, different lane.
                                worldEvents.push({kind: 'clusterPartner', at: p, lane: partnerLane, sideBySide: true});
                            } else {
                                // Slalom: staggered so the player must navigate both.
                                const stagger = CLUSTER_STAGGER_MIN
                                    + Math.floor(rand() * (CLUSTER_STAGGER_MAX - CLUSTER_STAGGER_MIN));
                                worldEvents.push({kind: 'clusterPartner', at: p + stagger, lane: partnerLane, sideBySide: false});
                                // Advance metronome to the partner's position so the
                                // regular gap resumes from there, not from p.
                                worldLastEventAt = p + stagger;
                            }
                        }
                    }
                }
            }
        }

        // Extend the generated horizon to at least `target` units.
        function generateWorldUpTo(target) {
            while (worldGeneratedThrough < target) {
                const from = worldGeneratedThrough;
                const to = from + WORLD_CHUNK_UNITS;
                generateChunk(from, to);
                worldGeneratedThrough = to;
            }
        }

        // Called once per frame from the loop. Advances the odometer, keeps
        // the horizon topped up, and instantiates events that have closed to
        // within their spawn distance.
        function tickWorld(delta) {
            if (speed > 0) {
                worldPos += (speed / 100) * 90 * delta;
            }
            generateWorldUpTo(worldPos + WORLD_LOOKAHEAD_UNITS);

            // worldEvents is sorted by .at; consume from the front while the
            // next event is within its spawn distance.
            while (worldEvents.length) {
                const ev = worldEvents[0];
                const dist = ev.at - worldPos;
                const spawnDist = WORLD_SPAWN_DIST[ev.kind] || 100;
                if (dist > spawnDist) break;
                worldEvents.shift();
                materializeEvent(ev, dist);
            }
        }

        // Wipe everything the world generator has put on the road right
        // now, plus the queued horizon. Called by cpu-race.js when a
        // challenge starts or ends so the player gets a clean slate.
        function clearAllWorldEvents() {
            worldEvents.length = 0;
            worldLastEventAt = -Infinity;
            // Preserve the sinkhole cooldown rather than resetting to -Infinity.
            // If reset to -Infinity, the generator can place a sinkhole at the
            // player's current position on the very next chunk, materialising
            // it at dist=0 and killing the player without warning. Setting to
            // worldPos enforces the full WORLD_SINKHOLE_MIN_SPACING gap from now.
            worldLastSinkholeAt = worldPos;
            worldLastGasCanAt = -Infinity;
            worldLastRampAt = -Infinity;
            worldLastWrenchAt = -Infinity;
            worldLastTunnelAt = -Infinity;
            worldLastBoosterAt = -Infinity;
            worldClearUntil = 0;
            // Reset the generated horizon to just-ahead so the next tickWorld
            // re-fills from worldPos with the new gating in effect.
            worldGeneratedThrough = worldPos;
            if (typeof clearObstacle === 'function') clearObstacle();
            if (typeof clearObstacle2 === 'function') clearObstacle2();
            if (typeof clearGasCan === 'function') clearGasCan();
            if (typeof clearWrench === 'function') clearWrench();
            if (typeof clearSinkhole === 'function') clearSinkhole();
            if (typeof clearRamp === 'function') clearRamp();
            if (typeof clearAirCoin === 'function') clearAirCoin();
            if (typeof clearPowerUpPickup === 'function') clearPowerUpPickup();
            if (typeof clearTunnel === 'function') clearTunnel();
            if (typeof clearCoin === 'function') clearCoin();
        }

        // Instantiate a single popped event subject to live-state gates. If
        // the gate fails (e.g. wrench at full health) the slot is silently
        // dropped — generator made it a candidate, runtime declined it.
        function materializeEvent(ev, dist) {
            // Challenge mode short-circuits every slot to a booster. The
            // perlin spacing still controls *when* boosters appear — they
            // just replace whatever the generator originally chose for that
            // slot.
            if (challengeState.active) {
                if (booster.active) return;
                if (worldPos - worldLastBoosterAt < WORLD_BOOSTER_MIN_SPACING) return;
                spawnBooster(ev.lane !== undefined ? ev.lane : Math.floor(rand() * 3), dist);
                worldLastBoosterAt = worldPos;
                return;
            }
            // Horn ball mode: most non-obstacle slots become obstacles so the
            // player has extra targets to shoot at. Sinkholes, tunnels, and
            // cluster partners are left unchanged (they're already challenging or
            // structural). The conversion is purely at materialise time so it
            // doesn't interfere with the pre-generated horizon.
            if (activePowerUp && activePowerUp.type === 'hornBall'
                    && ev.kind !== 'obstacle'
                    && ev.kind !== 'clusterPartner'
                    && ev.kind !== 'sinkhole'
                    && ev.kind !== 'tunnel') {
                if (rand() < HORNBALL_OBSTACLE_CONVERT_CHANCE) {
                    if (!obstacle.active && !sinkhole.active) {
                        spawnObstacle(ev.lane, dist);
                    }
                    return;
                }
            }
            switch (ev.kind) {
                case 'clusterPartner':
                    // Cluster partner always uses obstacle2. Not gated on obstacle.active
                    // (it's intentionally co-spawned with or shortly after obstacle1).
                    if (obstacle2.active) return;
                    spawnObstacle2(ev.lane, dist, ev.sideBySide);
                    return;
                case 'sinkhole':
                    // Only one ground-hazard at a time. If something is in the
                    // way we drop it — the global spacing already keeps these
                    // sparse enough that the drop is rare.
                    if (sinkhole.active || obstacle.active) return;
                    spawnSinkhole(dist);
                    return;
                case 'obstacle':
                    if (obstacle.active || sinkhole.active) return;
                    spawnObstacle(ev.lane, dist);
                    return;
                case 'gasCan':
                    if (gasCan.active) return;
                    if (activePowerUp && activePowerUp.type === 'rocket') {
                        if (!powerUpPickup.active) {
                            if (rand() < rocketConversionChance()) {
                                if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                            } else if (rand() < ROCKET_PICKUP_SKIP_CHANCE) {
                                // Thin out mid-run rocket pickups by ~10%: drop the
                                // slot to an obstacle instead so extensions don't
                                // cluster. No gas cans spawn during a rocket run.
                                if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                            } else {
                                spawnPowerUpPickup(ev.lane, dist, 'rocket');
                            }
                        }
                        return;
                    }
                    if (worldPos - worldLastGasCanAt < WORLD_CLUSTER_WINDOW_UNITS) {
                        if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                        return;
                    }
                    spawnGasCan(ev.lane, dist);
                    worldLastGasCanAt = worldPos;
                    return;
                case 'wrench':
                    if (wrench.active) return;
                    // No clustering — keep wrenches spaced out. If one passed
                    // recently, this slot becomes an ordinary obstacle.
                    if (worldPos - worldLastWrenchAt < WORLD_CLUSTER_WINDOW_UNITS) {
                        if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                        return;
                    }
                    // Spawn likelihood scales with health: rarer the healthier
                    // you are, but always possible (floor at full health).
                    if (rand() >= wrenchSpawnChance()) {
                        if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                        return;
                    }
                    spawnWrench(ev.lane, dist);
                    worldLastWrenchAt = worldPos;
                    return;
                case 'ramp':
                    if (ramp.active) return;
                    if (worldPos - worldLastRampAt < WORLD_CLUSTER_WINDOW_UNITS) {
                        if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                        return;
                    }
                    spawnRamp(ev.lane, dist);
                    worldLastRampAt = worldPos;
                    return;
                case 'powerUp':
                    if (powerUpPickup.active) return;
                    if (rand() >= powerUpSpawnChance()) {
                        if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                        return;
                    }
                    {
                        const type = POWERUP_TYPES[Math.floor(rand() * POWERUP_TYPES.length)];
                        if (type === 'shield' && shieldCount >= 3) {
                            if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                            return;
                        }
                        if (type === 'shield' && shieldCount === 1 && rand() < 0.50) {
                            if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                            return;
                        }
                        if (type === 'shield' && shieldCount === 2 && rand() < 0.65) {
                            if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                            return;
                        }
                        // Mid-rocket-run, rocket pickups can be swapped for obstacles
                        // at a chance that rises with accumulated rocket time.
                        if (type === 'rocket' && rand() < rocketConversionChance()) {
                            if (!obstacle.active && !sinkhole.active) spawnObstacle(ev.lane, dist);
                            return;
                        }
                        spawnPowerUpPickup(ev.lane, dist, type);
                    }
                    return;
                case 'tunnel':
                    // Score gate + dice roll were already applied at generation
                    // time so the reservation isn't wasted. Only the in-the-moment
                    // collision guard remains.
                    if (tunnel.active) return;
                    spawnTunnel(dist);
                    return;
            }
        }

        syngen.loop.on('frame', ({delta}) => {
            gamepadTick();
            if (!gameRunning || paused) {
                rumble.tick();
                draw();
                return;
            }

            // Lane-change repeat (driven by keyboard arrows or gamepad stick).
            if (laneHeld !== 0 && syngen.time() >= laneHeldNextAt) {
                moveLane(laneHeld);
                laneHeldNextAt = syngen.time() + LANE_REPEAT_SECONDS;
            }

            // Ease smoothedLane toward lane. Longer time constant = slower per-ear delay
            // change = less audible chirp on lane switch. 0.28s is well past the point where
            // the delay-line modulation drops below the pitch-perception threshold while still
            // feeling responsive for gameplay.
            {
                const k = 1 - Math.exp(-delta / 0.28);
                smoothedLane += (lane - smoothedLane) * k;
            }

            // Run-wide average speed sample, and total airtime accumulator.
            stats.speedSum += speed;
            stats.speedFrames += 1;
            if (jumping) stats.totalAirTime += delta;

            const rocketActive = !!(activePowerUp && activePowerUp.type === 'rocket');
            updatePlayerBoost();
            const boostActive = playerBoost.active;

            // Keyboard ArrowUp/Down (digital, full rate) takes precedence; otherwise
            // the gamepad triggers' net analog value (RT - LT) scales the same
            // THROTTLE_RATE so a half-pulled trigger ramps at half speed.
            // Touch drag on the canvas sets the target directly (positional, not rate).
            const throttleInput = throttleHeld !== 0 ? throttleHeld : throttleAnalog;
            // Boosters can push speed up to a hard cap of 175 — above the
            // health ceiling and the rocket cap. While a booster is active the
            // throttle target is pinned to the boost target so the car drives
            // there in ~3 s; after the 5 s hold the throttle takes over again.
            const speedCap = boostActive
                ? CHALLENGE_BOOST_CAP
                : (rocketActive ? 100 : maxSpeedFromHealth());
            if (touchThrottleActive && !rocketActive && !boostActive) {
                targetSpeed = Math.max(0, Math.min(speedCap, touchThrottleTarget));
                maybeFireThrottleClick();
            } else if (throttleInput !== 0 && !rocketActive && !boostActive) {
                targetSpeed = Math.max(0, Math.min(speedCap, targetSpeed + throttleInput * THROTTLE_RATE * delta));
                maybeFireThrottleClick();
            } else if (!rocketActive && !boostActive && targetSpeed > speedCap) {
                // Health just dropped under a tier — pull the throttle target down
                // to the new ceiling so the car can't keep coasting above it.
                targetSpeed = speedCap;
            }
            if (boostActive) {
                targetSpeed = Math.max(targetSpeed, playerBoost.targetSpeed);
            }

            // Backfire window: engine cuts pulling. Speed bleeds even if the
            // throttle is mashed, and accel is suppressed until the cough clears.
            const backfireActive = syngen.time() < backfireActiveUntil;

            if (jumping) {
                if (rocketActive) {
                    // Rockets still fire in the air, and there's no rolling
                    // resistance up here — so instead of bleeding speed the car
                    // climbs toward ROCKET_AIR_SPEED (175). The engine itself
                    // stays at idle aloft (the rev arc is in currentRpm()).
                    speed = Math.min(ROCKET_AIR_SPEED, speed + ROCKET_AIR_BOOST_RATE * delta);
                } else {
                    // Off-throttle in the air: bleed 2 mph/s (= 20 mph over a 10 s
                    // hang time). The throttle target is preserved, so the car
                    // re-accelerates up to it on landing (engine.js applies the
                    // load envelope).
                    speed = Math.max(0, speed - 2 * delta);
                }
            } else if (shifting) {
                // Torque is interrupted while the shift completes — speed coasts (no power applied).
                shiftElapsed += delta;
                if (shiftElapsed >= SHIFT_DURATION) {
                    shifting = false;
                    gear = shiftToGear;
                }
            } else if (speed !== targetSpeed) {
                if (targetSpeed > speed) {
                    if (backfireActive && !rocketActive) {
                        // Engine can't pull during the backfire vent — hold speed.
                        // Powered accel is gated; if the player releases throttle the
                        // targetSpeed < speed branch below will still bring them down.
                    } else if (syngen.time() < accelHoldUntil) {
                        // Post-hit recovery hold — speed was just scrubbed by the game.
                        // Hold flat (no powered pull) until the delay clears, then the
                        // car climbs back toward the untouched targetSpeed on its own.
                    } else {
                        // Rocket lifts the asymptote so speed can actually reach 150,
                        // and a 1.4× off-the-line boost makes the climb feel decisive.
                        // Health damage flattens both A0 and the asymptote, so a wounded
                        // engine climbs slower *and* tops out sooner.
                        const healthFactor = (rocketActive || boostActive) ? 1 : accelHealthFactor();
                        const a0Base = boostActive
                            ? ACCEL_A0 * 1.6
                            : (rocketActive ? ACCEL_A0 * 1.4 : ACCEL_A0);
                        const a0 = a0Base * healthFactor;
                        const vInf = boostActive
                            ? CHALLENGE_BOOST_CAP + 10
                            : (rocketActive
                                ? 200
                                : Math.max(maxSpeedFromHealth() + 12, ACCEL_V_INF * (0.55 + 0.45 * healthFactor)));
                        const accel = a0 * Math.max(0, 1 - speed / vInf);
                        speed = Math.min(targetSpeed, speed + accel * delta);
                    }
                } else {
                    speed = Math.max(targetSpeed, speed - DECEL_RATE * delta);
                }
                const ng = desiredGear(speed, gear);
                if (ng !== gear) {
                    shifting = true;
                    shiftElapsed = 0;
                    shiftFromRpm = rpmInGear(gear, speed);
                    shiftToGear = ng;
                }
            }

            {
                const bucket = Math.floor(speed / SPEED_ANNOUNCE_BUCKET);
                if (bucket !== lastSpeedBucket) {
                    const crossed = Math.max(bucket, lastSpeedBucket) * SPEED_ANNOUNCE_BUCKET;
                    announce(`${crossed} miles per hour`, {category: 'speed'});
                    lastSpeedBucket = bucket;
                }
            }

            updateSpeedGauge(speed);
            uiScore.textContent = score;

            // Advance the world odometer, top up the perlin-generated horizon,
            // and materialize any events that have closed within spawn range.
            // This is the single source of spawning — all the per-entity
            // schedule*Spawn timers have been removed.
            tickWorld(delta);

            // CPU opponent + booster advancement. updateCpu owns the
            // spawn/handshake/AI/boost/collision/win-check logic; here we
            // just advance booster geometry and clean up off-screen pickups
            // (mirrors gas-can / wrench in the blocks below).
            updateCpu(delta);
            if (booster.active) {
                booster.distance -= (speed / 100) * 90 * delta;
                if (booster.distance <= BOOSTER_DESPAWN_AT) clearBooster();
            }

            // ===== Jump tick =====
            // While airborne the car holds its speed (no accel/decel), all ground-based
            // hazards pass underneath safely, and lane changes still apply. The rev arc
            // is computed inside currentRpm() so the engine audio handles itself.
            if (jumping && syngen.time() >= jumpEndsAt) {
                endJump();
            }

            if (speed > 0 && obstacle.active) {
                // Scale closure rate by frame delta so behaviour is framerate-independent.
                obstacle.distance -= (speed / 100) * 90 * delta;

                    // Record the tightest moment the player was still in the obstacle's lane.
                    // Used at pass time to award a near-miss bonus: a last-second swerve at
                    // distance ~0 is a perfect near miss; swerving early (distance ~100)
                    // contributes nothing.
                    if (obstacle.lane === lane && obstacle.distance < obstacle.minSameLaneDistance) {
                        obstacle.minSameLaneDistance = obstacle.distance;
                    }

                    // Fire crash/pass exactly once, as the obstacle crosses the player plane.
                    if (!obstacle.passed && obstacle.distance <= 0) {
                        obstacle.passed = true;
                        if (obstacle.lane === lane && !jumping) {
                            if (shieldCount > 0) {
                                shieldCount--;
                                stats.shieldsAbsorbed += 1;
                                playShieldBloom();
                                playShieldCountIndicator(shieldCount);
                                const rem = shieldCount;
                                announce(
                                    `Shield absorbed obstacle. ${rem > 0 ? `${rem} shield${rem !== 1 ? 's' : ''} remaining.` : 'No shields left.'}`,
                                    {category: 'powerups'}
                                );
                                clearObstacle();
                                return;
                            }
                            playCue(120, 0.5, 'triangle');
                            // Damage scales with collision speed: a tap at idle is survivable,
                            // a head-on at 100 mph wipes out a full health bar in one go.
                            // Min 20 keeps slow collisions from being meaningless.
                            // Rocket armour absorbs 75% of incoming damage.
                            let damage = Math.max(20, Math.round(speed));
                            if (activePowerUp && activePowerUp.type === 'rocket') {
                                damage = Math.max(5, Math.round(damage * 0.25));
                            }
                            health = Math.max(0, health - damage);
                            // Scrub actual speed only — leave targetSpeed alone so the
                            // car (including a throttle-locked rocket) re-accelerates
                            // back to it after a short recovery hold.
                            speed = Math.max(0, speed - 40);
                            accelHoldUntil = syngen.time() + SLOWDOWN_RECOVERY_DELAY;
                            score -= 5;
                            stats.crashes += 1;
                            nearMissStreak = 0;
                            if (health === 0) {
                                announce(`Crash! Vehicle destroyed.`);
                                clearObstacle();
                                gameOver("You wiped out!.");
                                return;
                            }
                            announce(`Crash! Took ${damage} damage. Health ${health} percent.`);
                            clearObstacle();
                            return;
                        } else {
                            // Dynamic scoring. Speed factor rewards higher-stakes passes
                            // (less reaction time = more skill). Near-miss factor rewards
                            // late swerves — players who change lanes immediately get the
                            // base 10, players who hold and swerve at the last moment
                            // approach the 45-point ceiling on that axis.
                            const speedFactor = Math.max(0, Math.min(1, speed / 100));
                            // Jumping over an obstacle is not a swerve — no near-miss credit.
                            const nearMissFactor = (jumping || obstacle.minSameLaneDistance === Infinity)
                                ? 0
                                : Math.max(0, Math.min(1, 1 - obstacle.minSameLaneDistance / 100));
                            const isNearMiss = nearMissFactor > 0.7;

                            if (isNearMiss) {
                                nearMissStreak++;
                            } else {
                                nearMissStreak = 0;
                            }

                            let points;
                            if (activePowerUp && activePowerUp.type === 'rocket') {
                                // +50% to +200% on base/speed component; near-miss tripled.
                                const baseAndSpeed = 10 + 45 * speedFactor;
                                const mult = 1.5 + rand() * 1.5;
                                points = Math.round(baseAndSpeed * mult + 45 * nearMissFactor * 3);
                            } else {
                                points = Math.round(10 + 45 * speedFactor + 45 * nearMissFactor);
                            }
                            // Two lanes away at the pass = no dodge happened. Half credit.
                            if (Math.abs(obstacle.lane - lane) >= 2) {
                                points = Math.round(points / 2);
                            }

                            // Streak multiplier: activates at NEAR_MISS_STREAK_MIN consecutive
                            // near misses, scales linearly to NEAR_MISS_MULT_MAX at NEAR_MISS_STREAK_CAP.
                            let streakMult = 1;
                            if (isNearMiss && nearMissStreak >= NEAR_MISS_STREAK_MIN) {
                                const t = Math.min(1,
                                    (nearMissStreak - NEAR_MISS_STREAK_MIN) /
                                    (NEAR_MISS_STREAK_CAP - NEAR_MISS_STREAK_MIN)
                                );
                                streakMult = NEAR_MISS_MULT_MIN + t * (NEAR_MISS_MULT_MAX - NEAR_MISS_MULT_MIN);
                                points = Math.round(points * streakMult);
                            }

                            if (speed >= LOW_SPEED_THRESHOLD) score += points;
                            stats.obstaclesAvoided += 1;
                            if (isNearMiss) stats.nearMisses += 1;
                            if (isNearMiss) playNearMiss(); else playCue(880, 0.2);
                            const flavor = isNearMiss ? "Near miss! " : "";
                            const streakMsg = (isNearMiss && nearMissStreak >= NEAR_MISS_STREAK_MIN)
                                ? ` Streak ${nearMissStreak}, ${streakMult.toFixed(1)}x.`
                                : "";
                            const pointsMsg = speed < LOW_SPEED_THRESHOLD
                                ? "No points — low speed."
                                : `Plus ${points} points.`;
                            announce(`${flavor}Obstacle passed.${streakMsg} ${pointsMsg}`, {category: 'items'});
                        }
                    }

                // Let the sound trail off behind the player before despawning.
                if (obstacle.distance <= OBSTACLE_DESPAWN_AT) {
                    clearObstacle();
                }
            }

            // Fuel burn — superlinear with speed. Floored at 0; running dry kills
            // the throttle but leaves the player able to coast and call out fuel.
            // Rocket freezes the tank in place; so does the jump (engine is idling
            // in the air, so we don't burn fuel during the airtime).
            if (speed > 0 && fuel > 0 && !rocketActive && !jumping && !challengeState.active) {
                fuel = Math.max(0, fuel - Math.pow(speed / 100, FUEL_BURN_EXPONENT) * FUEL_BURN_AT_100 * delta);
                if (fuel === 0 && !outOfFuelAnnounced) {
                    outOfFuelAnnounced = true;
                    targetSpeed = 0;
                    announce("Out of fuel. Coasting to a stop.");
                }
            }
            if (fuel === 0 && !rocketActive) {
                targetSpeed = 0;
                if (speed === 0 && gameRunning) {
                    gameOver("You ran out of fuel!");
                    return;
                }
            }

            // Gas can approach / collection. Spawning is now handled by the
            // world generator; we only advance and resolve once active.
            if (speed > 0 && gasCan.active) {
                gasCan.distance -= (speed / 100) * 90 * delta;
                if (!gasCan.consumed && gasCan.distance <= 0) {
                    gasCan.consumed = true;
                    if (gasCan.lane === lane && !jumping) {
                        stats.gasCansCollected += 1;
                        if (rocketActive) {
                            activePowerUp.expiresAt += ROCKET_GASCAN_EXTEND;
                            playCue(660, 0.1, 'sine');
                            playCue(990, 0.12, 'sine');
                            announce(`Rocket extended.`, {category: 'powerups'});
                        } else {
                            fuel = Math.min(FUEL_MAX, fuel + gasCan.amount);
                            outOfFuelAnnounced = false;
                            playCue(660, 0.18, 'sine');
                            playCue(990, 0.18, 'sine');
                            announce(`Gas can collected. ${describeFuel()}`, {category: 'items'});
                        }
                        clearGasCan();
                    }
                }
                if (gasCan.active && gasCan.distance <= GAS_CAN_DESPAWN_AT) {
                    clearGasCan();
                }
            }

            // Wrench approach / pickup. Generator emits the candidate slots
            // and materializes them with a health-scaled probability; here we
            // just resolve once one is on the road.
            if (speed > 0 && wrench.active) {
                wrench.distance -= (speed / 100) * 90 * delta;
                if (!wrench.consumed && wrench.distance <= 0) {
                    wrench.consumed = true;
                    if (wrench.lane === lane && !jumping) {
                        stats.wrenchesCollected += 1;
                        const wasFullHealth = health >= HEALTH_MAX;
                        health = Math.min(HEALTH_MAX, health + WRENCH_HEAL_AMOUNT);
                        if (wasFullHealth) {
                            playWrenchPickupFull();
                        } else {
                            playWrenchPickup();
                        }
                        announce(`Wrench collected. Health ${health} percent.`, {category: 'items'});
                        clearWrench();
                    }
                }
                if (wrench.active && wrench.distance <= WRENCH_DESPAWN_AT) {
                    clearWrench();
                }
            }

            // Ramp approach / hit. Generator emits ramps; here we resolve.
            if (speed > 0 && ramp.active) {
                ramp.distance -= (speed / 100) * 90 * delta;
                if (!ramp.consumed && ramp.distance <= 0) {
                    ramp.consumed = true;
                    if (ramp.lane === lane && !jumping) {
                        stats.rampsHit += 1;
                        if (speed < RAMP_MIN_SPEED) {
                            // Too slow — bounce backwards. Speed clamps to 0;
                            // targetSpeed is left alone so the car re-accelerates after
                            // the brief recovery hold below.
                            playLandingImpact();
                            speed = 0;
                            accelHoldUntil = syngen.time() + SLOWDOWN_RECOVERY_DELAY;
                            announce(`Bounced off the ramp.`, {category: 'items'});
                        } else {
                            startJump(rampAirtimeForSpeed(speed));
                        }
                        clearRamp();
                    } else {
                        stats.rampsMissed += 1;
                    }
                }
                if (ramp.active && ramp.distance <= RAMP_DESPAWN_AT) {
                    clearRamp();
                }
            }

            // Air coins — spawn frequently while airborne, no announcements. Each
            // collected coin awards points and extends the existing horn-ball-style
            // streak (a quick chain of mid-air pickups builds a multiplier).
            if (jumping) {
                if (!airCoin.active) {
                    if (syngen.time() >= airCoin.nextSpawnAt) spawnAirCoin();
                } else {
                    airCoin.distance -= (speed / 100) * 90 * delta;
                    if (!airCoin.consumed && airCoin.distance <= 0) {
                        airCoin.consumed = true;
                        if (airCoin.lane === lane) {
                            const base = AIR_COIN_VALUE_MIN
                                + Math.floor(rand() * (AIR_COIN_VALUE_MAX - AIR_COIN_VALUE_MIN + 1));
                            // Reuse the streak system: each pickup either starts a fresh
                            // streak or extends it, with the multiplier applied to base.
                            const now = syngen.time();
                            if (streak.count === 0 || now >= streak.expiresAt) {
                                streak.count = 1;
                                streak.multiplier = 1;
                                streak.nextHitNoteHz = STREAK_BASE_HZ;
                                streak.expiresAt = now + STREAK_FIRST_WINDOW;
                                score += base;
                            } else {
                                streak.count += 1;
                                streak.expiresAt = Math.min(streak.expiresAt + STREAK_EXTEND, now + STREAK_MAX_WINDOW);
                                streak.multiplier = 1 + Math.log(streak.count) / Math.log(2);
                                score += Math.round(base * streak.multiplier);
                            }
                            playStreakChirp(streak.nextHitNoteHz);
                            streak.nextHitNoteHz *= STREAK_QUARTER_TONE;
                            playCoinCollect(coinCollectHz(streak.count - 1));
                            stats.coinsCollected += 1;
                            clearAirCoin();
                            scheduleNextAirCoinSpawn();
                        }
                    }
                    if (airCoin.active && airCoin.distance <= -50) {
                        clearAirCoin();
                        scheduleNextAirCoinSpawn();
                    }
                }
            } else if (airCoin.active) {
                // Safety: clear any lingering air coin when the player lands.
                clearAirCoin();
            }

            // Sinkhole approach / traversal / death-check / despawn.
            // Spawning is handled by the world generator (js/world.js).
            if (sinkhole.active) {
                sinkhole.frontDistance -= (speed / 100) * 90 * delta;

                // Front edge reaches player — traversal begins
                if (!sinkhole.traversalStarted && sinkhole.frontDistance <= 0) {
                    sinkhole.traversalStarted = true;
                }

                // Instant death if player is in a blocked lane during traversal
                if (sinkhole.traversalStarted && !sinkhole.cleared && !jumping && lane !== sinkhole.freeLane) {
                    announce(`Sink hole! Eliminated.`, {category: 'sinkholes'});
                    clearSinkhole();
                    gameOver("You fell into a sinkhole.");
                    return;
                }

                // Back edge passes player — traversal cleared, award points
                if (!sinkhole.cleared && sinkhole.frontDistance <= -SINKHOLE_ZONE_LENGTH) {
                    sinkhole.cleared = true;
                    stats.sinkholesTraversed += 1;
                    score += SINKHOLE_POINTS;
                    playCue(660, 0.2, 'sine', -8);
                    playCue(990, 0.25, 'sine', -8);
                    announce(`Sink hole cleared. Plus ${SINKHOLE_POINTS} points.`, {category: 'sinkholes'});
                }

                // Despawn once well past the player. The world generator owns
                // the next-sinkhole decision via its spacing + cushion rules.
                if (sinkhole.frontDistance <= -(SINKHOLE_ZONE_LENGTH + SINKHOLE_DESPAWN_TAIL)) {
                    clearSinkhole();
                }
            }

            // Power-up score-ceiling + high-speed time tracking.
            // Ceiling is monotonic (never decremented) so bouncing across a 500-point
            // threshold doesn't repeatedly re-trigger the spawn nudge.
            if (score > powerUpScoreCeiling) powerUpScoreCeiling = score;
            if (speed >= POWERUP_HIGH_SPEED_MPH) highSpeedSeconds += delta;

            // Power-up pickup approach / collection. Generator emits the
            // candidate slots (gated by powerUpSpawnChance at materialization).
            if (speed > 0 && powerUpPickup.active) {
                powerUpPickup.distance -= (speed / 100) * 90 * delta;
                if (!powerUpPickup.consumed && powerUpPickup.distance <= 0) {
                    powerUpPickup.consumed = true;
                    if (powerUpPickup.lane === lane && !jumping) {
                        pushPowerUp(powerUpPickup.type);
                        clearPowerUpPickup();
                    }
                }
                if (powerUpPickup.active && powerUpPickup.distance <= POWERUP_DESPAWN_AT) {
                    clearPowerUpPickup();
                }
            }

            // Tunnel advance / enter / power-up boost / exit / despawn.
            // Coin spawning for tunnels is handled in the coin block below.
            if (speed > 0 && tunnel.active) {
                tunnel.frontDistance -= (speed / 100) * 90 * delta;

                if (!tunnel.entered && tunnel.frontDistance <= 0) {
                    enterTunnel();
                }

                if (tunnel.entered && !tunnel.cleared) {
                    // Boosted power-up spawn — rocket heavily favoured (60%).
                    if (!powerUpPickup.active && syngen.time() >= tunnel.nextPowerUpAt) {
                        const chance = Math.min(POWERUP_MAX_CHANCE,
                            powerUpSpawnChance() * TUNNEL_ROCKET_CHANCE_MULT);
                        if (rand() < chance) {
                            const type = rand() < 0.6
                                ? 'rocket'
                                : POWERUP_TYPES[Math.floor(rand() * POWERUP_TYPES.length)];
                            spawnPowerUpPickup(Math.floor(rand() * 3), 100, type);
                        }
                        tunnel.nextPowerUpAt = syngen.time()
                            + TUNNEL_POWERUP_INTERVAL_MIN
                            + rand() * (TUNNEL_POWERUP_INTERVAL_MAX - TUNNEL_POWERUP_INTERVAL_MIN);
                    }
                    // Back edge crossing — tunnel complete.
                    if (tunnel.frontDistance <= -tunnel.length) {
                        exitTunnel();
                    }
                }

                if (tunnel.frontDistance <= -(tunnel.length + TUNNEL_DESPAWN_TAIL)) {
                    clearTunnel();
                }
            }

            // Coins — rocket-only outside a tunnel; staggered across all lanes inside one.
            {
                const inTunnel = tunnel.entered && !tunnel.cleared;
                if (speed > 0 && (rocketActive || inTunnel)) {
                    if (!coin.active) {
                        if (inTunnel) {
                            // Tunnel spawner: staggered lane, shorter gap.
                            if (syngen.time() >= coin.nextSpawnAt) spawnTunnelCoin();
                        } else if (!sinkhole.active && syngen.time() >= coin.nextSpawnAt) {
                            spawnCoin();
                        }
                    } else {
                        coin.distance -= (speed / 100) * 90 * delta;
                        if (!coin.consumed && coin.distance <= 0) {
                            coin.consumed = true;
                            if (coin.lane === lane && !jumping) {
                                const base = COIN_VALUE_MIN
                                    + Math.floor(rand() * (COIN_VALUE_MAX - COIN_VALUE_MIN + 1));
                                const now = syngen.time();
                                if (streak.count === 0 || now >= streak.expiresAt) {
                                    streak.count = 1;
                                    streak.multiplier = 1;
                                    streak.nextHitNoteHz = STREAK_BASE_HZ;
                                    streak.expiresAt = now + STREAK_FIRST_WINDOW;
                                    score += base;
                                } else {
                                    streak.count += 1;
                                    streak.expiresAt = Math.min(streak.expiresAt + STREAK_EXTEND, now + STREAK_MAX_WINDOW);
                                    streak.multiplier = 1 + Math.log(streak.count) / Math.log(2);
                                    score += Math.round(base * streak.multiplier);
                                }
                                playStreakChirp(streak.nextHitNoteHz);
                                streak.nextHitNoteHz *= STREAK_QUARTER_TONE;
                                playCoinCollect(coinCollectHz(streak.count - 1));
                                stats.coinsCollected += 1;
                                clearCoin();
                                if (inTunnel) {
                                    scheduleNextTunnelCoinSpawn();
                                } else {
                                    scheduleNextCoinSpawn();
                                }
                            }
                        }
                        if (coin.active && coin.distance <= -50) {
                            clearCoin();
                            if (inTunnel) {
                                scheduleNextTunnelCoinSpawn();
                            } else {
                                scheduleNextCoinSpawn();
                            }
                        }
                    }
                }
            }

            // Horn-ball projectile motion and collision.
            updateProjectile(delta);

            // Active power-up lifetime + streak timeout.
            updateActivePowerUp(delta);
            updateStreak();

            updateFuelGauge(fuel);
            updateHealthGauge(health);
            updatePowerUpHud();

            if (!gameRunning) { draw(); return; }

            updateObstacleAudio();
            updateBoosterAudio();
            updateCpuEngineAudio();
            updateGasCanAudio();
            updateWrenchAudio();
            updatePowerUpPickupAudio();
            updateCoinAudio();
            updateRampAudio();
            updateAirCoinAudio();
            updateSinkholeAudio();
            tickEngineDamage(delta);
            updateEngineAudio();
            updateGroundOcclusion();
            rumble.tick();
            draw();
        });

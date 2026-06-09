        function draw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const scaleX = canvas.width / 600;
            const scaleY = canvas.height / 400;
            ctx.save();
            ctx.scale(scaleX, scaleY);

            ctx.strokeStyle = '#444';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(200, 0); ctx.lineTo(200, 400);
            ctx.moveTo(400, 0); ctx.lineTo(400, 400);
            ctx.stroke();

            const dashOffset = (Date.now() / (200 - speed + 1)) % 40;
            ctx.strokeStyle = '#ffcc00';
            ctx.lineWidth = 2;
            ctx.setLineDash([20, 20]);
            ctx.lineDashOffset = -dashOffset;
            ctx.beginPath();
            ctx.moveTo(200, 0); ctx.lineTo(200, 400);
            ctx.moveTo(400, 0); ctx.lineTo(400, 400);
            ctx.stroke();
            ctx.setLineDash([]);

            // Sinkhole visual: dark filled region in blocked lanes
            if (sinkhole.active && !sinkhole.cleared) {
                const frontY = 320 - sinkhole.frontDistance * 3.2;
                ctx.fillStyle = 'rgba(15, 3, 3, 0.82)';
                if (sinkhole.traversalStarted) {
                    // Full columns blocked — sinkhole is at/past the player
                    if (sinkhole.freeLane === 2) {
                        ctx.fillRect(0, 0, 400, 400);
                    } else {
                        ctx.fillRect(200, 0, 400, 400);
                    }
                } else if (frontY > 0) {
                    // Front edge still ahead — fill from canvas top down to edge
                    if (sinkhole.freeLane === 2) {
                        ctx.fillRect(0, 0, 400, frontY);
                    } else {
                        ctx.fillRect(200, 0, 400, frontY);
                    }
                    // Draw front-edge glow
                    ctx.strokeStyle = '#8b0000';
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    if (sinkhole.freeLane === 2) {
                        ctx.moveTo(0, frontY); ctx.lineTo(400, frontY);
                    } else {
                        ctx.moveTo(200, frontY); ctx.lineTo(600, frontY);
                    }
                    ctx.stroke();
                }
            }

            if (ramp.active) {
                const rampY = 320 - (ramp.distance * 3.2);
                const rampX = lanePositionsX[ramp.lane];
                // Trapezoid suggesting a ramp incline.
                ctx.fillStyle = '#66cc66';
                ctx.beginPath();
                ctx.moveTo(rampX - 22, rampY + 18);
                ctx.lineTo(rampX + 22, rampY + 18);
                ctx.lineTo(rampX + 35, rampY - 18);
                ctx.lineTo(rampX - 35, rampY - 18);
                ctx.closePath();
                ctx.fill();
            }

            if (obstacle.active) {
                const obstacleY = 320 - (obstacle.distance * 3.2);
                const obstacleX = lanePositionsX[obstacle.lane];
                ctx.fillStyle = '#ff3333';
                ctx.fillRect(obstacleX - 30, obstacleY - 20, 60, 40);
            }

            if (obstacle2.active) {
                const obstacle2Y = 320 - (obstacle2.distance * 3.2);
                const obstacle2X = lanePositionsX[obstacle2.lane];
                ctx.fillStyle = '#ff8833';
                ctx.fillRect(obstacle2X - 30, obstacle2Y - 20, 60, 40);
            }

            if (powerUpPickup.active) {
                const pY = 320 - (powerUpPickup.distance * 3.2);
                const pX = lanePositionsX[powerUpPickup.lane];
                if (powerUpPickup.type === 'shield') {
                    ctx.fillStyle = '#1a66ff';
                    ctx.strokeStyle = '#bfe0ff';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(pX, pY - 22);
                    ctx.lineTo(pX + 18, pY - 14);
                    ctx.lineTo(pX + 18, pY + 4);
                    ctx.quadraticCurveTo(pX + 18, pY + 20, pX, pY + 24);
                    ctx.quadraticCurveTo(pX - 18, pY + 20, pX - 18, pY + 4);
                    ctx.lineTo(pX - 18, pY - 14);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                } else if (powerUpPickup.type === 'rocket') {
                    ctx.fillStyle = '#ff6a00';
                    ctx.beginPath();
                    ctx.moveTo(pX - 8, pY + 14);
                    ctx.quadraticCurveTo(pX, pY + 26, pX + 8, pY + 14);
                    ctx.lineTo(pX + 4, pY + 14);
                    ctx.quadraticCurveTo(pX, pY + 22, pX - 4, pY + 14);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = '#ffd633';
                    ctx.beginPath();
                    ctx.moveTo(pX, pY + 18);
                    ctx.quadraticCurveTo(pX - 4, pY + 22, pX, pY + 26);
                    ctx.quadraticCurveTo(pX + 4, pY + 22, pX, pY + 18);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = '#e0e0e0';
                    ctx.beginPath();
                    ctx.moveTo(pX, pY - 22);
                    ctx.lineTo(pX + 8, pY + 14);
                    ctx.lineTo(pX - 8, pY + 14);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = '#cc2222';
                    ctx.beginPath();
                    ctx.moveTo(pX - 8, pY + 14);
                    ctx.lineTo(pX - 16, pY + 18);
                    ctx.lineTo(pX - 8, pY + 6);
                    ctx.closePath();
                    ctx.moveTo(pX + 8, pY + 14);
                    ctx.lineTo(pX + 16, pY + 18);
                    ctx.lineTo(pX + 8, pY + 6);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = '#66ccff';
                    ctx.beginPath();
                    ctx.arc(pX, pY - 8, 3, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    ctx.fillStyle = '#cc2222';
                    ctx.beginPath();
                    ctx.arc(pX, pY, 18, Math.PI / 2, -Math.PI / 2, false);
                    ctx.fill();
                    ctx.fillStyle = '#22aa44';
                    ctx.beginPath();
                    ctx.arc(pX, pY, 18, -Math.PI / 2, Math.PI / 2, false);
                    ctx.fill();
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(pX, pY - 18);
                    ctx.lineTo(pX, pY + 18);
                    ctx.stroke();
                }
            }

            if (coin.active) {
                const cY = 320 - (coin.distance * 3.2);
                const cX = lanePositionsX[coin.lane];
                ctx.fillStyle = '#ffd633';
                ctx.beginPath();
                ctx.arc(cX, cY, 14, 0, Math.PI * 2);
                ctx.fill();
            }

            if (gasCan.active) {
                const gY = 320 - (gasCan.distance * 3.2);
                const gX = lanePositionsX[gasCan.lane];
                // Body
                ctx.fillStyle = '#cc1a1a';
                ctx.fillRect(gX - 16, gY - 14, 32, 32);
                // Yellow safety stripe
                ctx.fillStyle = '#ffd633';
                ctx.fillRect(gX - 16, gY + 2, 32, 5);
                // Spout (top-right)
                ctx.fillStyle = '#8a8a8a';
                ctx.fillRect(gX + 6, gY - 22, 9, 10);
                ctx.fillStyle = '#cc1a1a';
                ctx.fillRect(gX + 8, gY - 24, 5, 4);
                // Handle (top-left arch)
                ctx.strokeStyle = '#1a1a1a';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(gX - 14, gY - 14);
                ctx.lineTo(gX - 14, gY - 20);
                ctx.lineTo(gX + 2, gY - 20);
                ctx.lineTo(gX + 2, gY - 14);
                ctx.stroke();
                // Body outline
                ctx.lineWidth = 2;
                ctx.strokeRect(gX - 16, gY - 14, 32, 32);
            }

            if (wrench.active) {
                const wY = 320 - (wrench.distance * 3.2);
                const wX = lanePositionsX[wrench.lane];
                ctx.save();
                ctx.translate(wX, wY);
                ctx.rotate(-Math.PI / 4);
                // Handle
                ctx.fillStyle = '#b8b8c0';
                ctx.fillRect(-4, -6, 8, 28);
                ctx.strokeStyle = '#202024';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(-4, -6, 8, 28);
                // Open-end jaw (top)
                ctx.fillStyle = '#b8b8c0';
                ctx.beginPath();
                ctx.moveTo(-10, -18);
                ctx.lineTo(10, -18);
                ctx.lineTo(10, -6);
                ctx.lineTo(4, -6);
                ctx.lineTo(4, -10);
                ctx.lineTo(-4, -10);
                ctx.lineTo(-4, -6);
                ctx.lineTo(-10, -6);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                // Closed (box) end at bottom
                ctx.beginPath();
                ctx.arc(0, 24, 8, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#3a3a44';
                ctx.beginPath();
                ctx.arc(0, 24, 3.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            if (projectile.active) {
                const prY = 320 - (projectile.distance * 3.2);
                const prX = lanePositionsX[projectile.lane];
                ctx.fillStyle = '#ffff66';
                ctx.beginPath();
                ctx.arc(prX, prY, 10, 0, Math.PI * 2);
                ctx.fill();
            }

            // Compute jump lift first — the same sin curve drives the player's
            // visual rise, the airborne ground-mask opacity, and (in loop.js)
            // the groundProps lowpass sweep. Keeping them in lockstep means
            // what the player sees on the canvas matches what they hear.
            let playerYOffset = 0;
            let lift = 0;
            if (jumping) {
                const total = jumpEndsAt - jumpStartedAt;
                if (total > 0) {
                    const p = Math.min(1, (syngen.time() - jumpStartedAt) / total);
                    lift = Math.sin(p * Math.PI);
                    playerYOffset = -lift * 60;
                }
            }

            // Airborne ground mask: at peak lift, fully obscures every ground
            // item drawn above so the player can't visually distinguish what's
            // under the car (matches the audio occlusion). Fades in on takeoff
            // and out on landing with the same sin curve as the player's rise.
            if (jumping && lift > 0) {
                ctx.save();
                ctx.fillStyle = `rgba(40, 50, 70, ${0.78 * lift})`;
                ctx.fillRect(0, 0, 600, 400);
                ctx.restore();
            }

            if (airCoin.active) {
                const cY = 320 - (airCoin.distance * 3.2);
                const cX = lanePositionsX[airCoin.lane];
                ctx.fillStyle = '#ffeb66';
                ctx.beginPath();
                ctx.arc(cX, cY - 30, 10, 0, Math.PI * 2);
                ctx.fill();
            }

            const playerX = lanePositionsX[lane];
            const playerY = 320 + playerYOffset;
            if (jumping) {
                // Ground shadow shrinks and fades as the car rises.
                const shadowScale = 1 - lift * 0.55;
                ctx.save();
                ctx.globalAlpha = 0.35 * (1 - lift * 0.6);
                ctx.fillStyle = '#000';
                ctx.beginPath();
                ctx.ellipse(playerX, 360, 28 * shadowScale, 8 * shadowScale, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
            ctx.fillStyle = '#0076ff';
            ctx.fillRect(playerX - 25, playerY - 40, 50, 80);

            ctx.fillStyle = '#ffffaa';
            ctx.fillRect(playerX - 20, playerY - 45, 10, 10);
            ctx.fillRect(playerX + 10, playerY - 45, 10, 10);

            // Throttle slider — right edge of canvas.
            // Track spans y=24 (top=max speed) to y=376 (bottom=zero).
            const TRACK_X   = 580;
            const TRACK_TOP = 24;
            const TRACK_BOT = 376;
            const TRACK_H   = TRACK_BOT - TRACK_TOP;

            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = '#000';
            ctx.fillRect(568, 14, 24, TRACK_H + 20);
            ctx.globalAlpha = 1;

            // Track rail
            ctx.fillStyle = '#3a3a3a';
            ctx.fillRect(TRACK_X - 2, TRACK_TOP, 4, TRACK_H);

            // Handle position: 0 mph at bottom, max at top.
            const maxSpd = maxSpeedFromHealth();
            const frac   = maxSpd > 0 ? Math.min(1, Math.max(0, targetSpeed / maxSpd)) : 0;
            const handleY = TRACK_BOT - frac * TRACK_H;

            // Filled portion of track (below handle = remaining, above = used).
            ctx.fillStyle = touchThrottleActive ? '#ffcc00' : '#0076ff';
            ctx.fillRect(TRACK_X - 2, handleY, 4, TRACK_BOT - handleY);

            // Handle grip
            ctx.fillStyle = touchThrottleActive ? '#ffcc00' : '#e0e0e0';
            ctx.fillRect(TRACK_X - 9, handleY - 7, 18, 14);

            // Tick marks at 25 / 50 / 75 mph
            ctx.strokeStyle = '#555';
            ctx.lineWidth = 1;
            for (const pct of [0.25, 0.5, 0.75]) {
                const ty = TRACK_BOT - pct * TRACK_H;
                ctx.beginPath();
                ctx.moveTo(TRACK_X - 6, ty);
                ctx.lineTo(TRACK_X + 6, ty);
                ctx.stroke();
            }

            ctx.restore(); // throttle slider restore

            ctx.restore(); // scale restore
        }

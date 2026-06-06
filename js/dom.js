        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        const startBtn = document.getElementById('start-btn');
const uiScore = document.getElementById('ui-score');
        const speedNeedle = document.getElementById('speed-needle');
        const fuelNeedle = document.getElementById('fuel-needle');
        const healthDamageRect = document.getElementById('health-damage-rect');
        const SPEED_GAUGE_MAX = 150;
        function updateSpeedGauge(s) {
            const clamped = Math.max(0, Math.min(SPEED_GAUGE_MAX, s));
            const angle = -135 + (clamped / SPEED_GAUGE_MAX) * 270;
            speedNeedle.setAttribute('transform', `rotate(${angle} 60 60)`);
        }
        function updateFuelGauge(f) {
            const clamped = Math.max(0, Math.min(1, f));
            const angle = -90 + clamped * 180;
            fuelNeedle.setAttribute('transform', `rotate(${angle} 60 80)`);
        }
        function updateHealthGauge(h) {
            const dmg = Math.max(0, Math.min(1, (HEALTH_MAX - h) / HEALTH_MAX));
            const height = dmg * 120;
            healthDamageRect.setAttribute('y', 120 - height);
            healthDamageRect.setAttribute('height', height);
        }
        const announcer = document.getElementById('announcer');
        const gameOverEl = document.getElementById('game-over');
        const goReasonEl = document.getElementById('go-reason');
        const goScoreEl = document.getElementById('go-score');
        const goTimeEl = document.getElementById('go-time');
        const restartBtn = document.getElementById('restart-btn');
        const statsToggle = document.getElementById('stats-toggle');
        const statsPanel = document.getElementById('stats-panel');
        const statsList = document.getElementById('stats-list');
        const instructionsBtn = document.getElementById('instructions-btn');
        const instructionsModal = document.getElementById('instructions-modal');
        const instructionsClose = document.getElementById('instructions-close');

        function openInstructions() {
            instructionsModal.hidden = false;
            instructionsClose.focus();
        }
        function closeInstructions() {
            instructionsModal.hidden = true;
            instructionsBtn.focus();
        }

        instructionsBtn.addEventListener('click', openInstructions);
        instructionsClose.addEventListener('click', closeInstructions);
        instructionsModal.addEventListener('click', (e) => {
            if (e.target === instructionsModal) closeInstructions();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !instructionsModal.hidden) closeInstructions();
        });

        function resizeCanvas() {
            const rect = canvas.getBoundingClientRect();
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            if (w > 0 && h > 0) {
                canvas.width  = w;
                canvas.height = h;
            }
        }
        requestAnimationFrame(resizeCanvas);
        window.addEventListener('resize', resizeCanvas);
        window.addEventListener('orientationchange', () => requestAnimationFrame(resizeCanvas));

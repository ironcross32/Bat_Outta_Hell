        // Persistent player options. Loaded before state.js so `verbosity` and
        // `ttsOptions` are available when announce() consults them. Values are
        // mirrored to localStorage on every change; missing/corrupt entries fall
        // back to the all-on defaults so first-time players hear everything.
        const OPTIONS_STORAGE_KEY = 'boh.options.v1';

        const VERBOSITY_DEFAULTS = {
            items: true,
            powerups: true,
            sinkholes: true,
            speed: true,
            lanes: true,
        };

        const TTS_DEFAULTS = {
            enabled: false,
            voiceURI: '',   // empty = browser default
            rate: 1,
            pitch: 1,
            volume: 1,
        };

        const CONTROLS_DEFAULTS = {
            tiltEnabled: false,
        };

        let verbosity = Object.assign({}, VERBOSITY_DEFAULTS);
        let ttsOptions = Object.assign({}, TTS_DEFAULTS);
        let controlsOptions = Object.assign({}, CONTROLS_DEFAULTS);

        (function loadOptions() {
            try {
                const raw = localStorage.getItem(OPTIONS_STORAGE_KEY);
                if (!raw) return;
                const parsed = JSON.parse(raw);
                if (parsed && parsed.verbosity && typeof parsed.verbosity === 'object') {
                    for (const k of Object.keys(VERBOSITY_DEFAULTS)) {
                        if (typeof parsed.verbosity[k] === 'boolean') verbosity[k] = parsed.verbosity[k];
                    }
                }
                if (parsed && parsed.tts && typeof parsed.tts === 'object') {
                    if (typeof parsed.tts.enabled === 'boolean') ttsOptions.enabled = parsed.tts.enabled;
                    if (typeof parsed.tts.voiceURI === 'string') ttsOptions.voiceURI = parsed.tts.voiceURI;
                    if (typeof parsed.tts.rate === 'number') ttsOptions.rate = parsed.tts.rate;
                    if (typeof parsed.tts.pitch === 'number') ttsOptions.pitch = parsed.tts.pitch;
                    if (typeof parsed.tts.volume === 'number') ttsOptions.volume = parsed.tts.volume;
                }
                if (parsed && parsed.controls && typeof parsed.controls === 'object') {
                    if (typeof parsed.controls.tiltEnabled === 'boolean') controlsOptions.tiltEnabled = parsed.controls.tiltEnabled;
                }
            } catch (_) { /* ignore corrupt storage */ }
        })();

        function saveOptions() {
            try {
                localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify({verbosity, tts: ttsOptions, controls: controlsOptions}));
            } catch (_) { /* quota / private mode — silently ignore */ }
        }

        // Build and speak a SpeechSynthesisUtterance using current ttsOptions.
        // Cancels any in-flight utterance first so the queue never backs up.
        function ttsSpeakRaw(text) {
            if (!window.speechSynthesis) return;
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.rate   = ttsOptions.rate;
            u.pitch  = ttsOptions.pitch;
            u.volume = ttsOptions.volume;
            if (ttsOptions.voiceURI) {
                const voices = speechSynthesis.getVoices();
                const match = voices.find(v => v.voiceURI === ttsOptions.voiceURI);
                if (match) u.voice = match;
            }
            speechSynthesis.speak(u);
        }

        // ===== Modal wiring =====
        const optionsBtn = document.getElementById('options-btn');
        const optionsModal = document.getElementById('options-modal');
        const optionsClose = document.getElementById('options-close');
        const verbItems = document.getElementById('verbosity-items');
        const verbPowerups = document.getElementById('verbosity-powerups');
        const verbSinkholes = document.getElementById('verbosity-sinkholes');
        const verbSpeed = document.getElementById('verbosity-speed');
        const verbLanes = document.getElementById('verbosity-lanes');

        const tiltEnabledEl    = document.getElementById('tilt-enabled');
        const tiltUnavailableEl = document.getElementById('tilt-unavailable');

        tiltEnabledEl.addEventListener('change', () => {
            if (!tiltEnabledEl.checked) {
                controlsOptions.tiltEnabled = false;
                tiltUnavailableEl.style.display = 'none';
                saveOptions();
                return;
            }
            // iOS 13+ requires an explicit permission grant from a user gesture.
            if (typeof DeviceOrientationEvent !== 'undefined' &&
                typeof DeviceOrientationEvent.requestPermission === 'function') {
                DeviceOrientationEvent.requestPermission().then((state) => {
                    if (state === 'granted') {
                        controlsOptions.tiltEnabled = true;
                        tiltUnavailableEl.style.display = 'none';
                    } else {
                        tiltEnabledEl.checked = false;
                        controlsOptions.tiltEnabled = false;
                        tiltUnavailableEl.style.display = 'block';
                    }
                    saveOptions();
                }).catch(() => {
                    tiltEnabledEl.checked = false;
                    controlsOptions.tiltEnabled = false;
                    tiltUnavailableEl.style.display = 'block';
                    saveOptions();
                });
            } else if (typeof DeviceOrientationEvent !== 'undefined') {
                // Android / desktop — no permission step needed.
                controlsOptions.tiltEnabled = true;
                saveOptions();
            } else {
                // API genuinely absent.
                tiltEnabledEl.checked = false;
                controlsOptions.tiltEnabled = false;
                tiltUnavailableEl.style.display = 'block';
                saveOptions();
            }
        });

        const ttsEnabled   = document.getElementById('tts-enabled');
        const ttsParams    = document.getElementById('tts-params');
        const ttsVoiceSel  = document.getElementById('tts-voice');
        const ttsRateEl    = document.getElementById('tts-rate');
        const ttsPitchEl   = document.getElementById('tts-pitch');
        const ttsVolumeEl  = document.getElementById('tts-volume');
        const ttsRateVal   = document.getElementById('tts-rate-val');
        const ttsPitchVal  = document.getElementById('tts-pitch-val');
        const ttsVolumeVal = document.getElementById('tts-volume-val');
        const ttsTestBtn   = document.getElementById('tts-test-btn');

        // Populate the voice <select>. The browser may not have voices ready on
        // first load; onvoiceschanged fires when they arrive (Chrome) or the
        // list is synchronously available (Firefox/Safari).
        function populateVoices() {
            if (!window.speechSynthesis) return;
            const voices = speechSynthesis.getVoices();
            if (!voices.length) return;
            ttsVoiceSel.innerHTML = '<option value="">Browser default</option>';
            for (const v of voices) {
                const opt = document.createElement('option');
                opt.value = v.voiceURI;
                opt.textContent = v.name + (v.localService ? '' : ' (online)');
                if (v.voiceURI === ttsOptions.voiceURI) opt.selected = true;
                ttsVoiceSel.appendChild(opt);
            }
        }

        if (window.speechSynthesis) {
            populateVoices();
            speechSynthesis.addEventListener('voiceschanged', populateVoices);
        }

        function syncTtsFromState() {
            ttsEnabled.checked = ttsOptions.enabled;
            ttsParams.hidden   = !ttsOptions.enabled;
            ttsRateEl.value    = ttsOptions.rate;
            ttsPitchEl.value   = ttsOptions.pitch;
            ttsVolumeEl.value  = ttsOptions.volume;
            ttsRateVal.textContent   = Number(ttsOptions.rate).toFixed(1);
            ttsPitchVal.textContent  = Number(ttsOptions.pitch).toFixed(1);
            ttsVolumeVal.textContent = Number(ttsOptions.volume).toFixed(2);
            populateVoices();
        }

        ttsEnabled.addEventListener('change', () => {
            ttsOptions.enabled = ttsEnabled.checked;
            ttsParams.hidden = !ttsOptions.enabled;
            saveOptions();
        });

        ttsVoiceSel.addEventListener('change', () => {
            ttsOptions.voiceURI = ttsVoiceSel.value;
            saveOptions();
        });

        function bindSlider(el, valEl, key, decimals) {
            el.addEventListener('input', () => {
                ttsOptions[key] = parseFloat(el.value);
                valEl.textContent = ttsOptions[key].toFixed(decimals);
                saveOptions();
            });
        }
        bindSlider(ttsRateEl,   ttsRateVal,   'rate',   1);
        bindSlider(ttsPitchEl,  ttsPitchVal,  'pitch',  1);
        bindSlider(ttsVolumeEl, ttsVolumeVal, 'volume', 2);

        ttsTestBtn.addEventListener('click', () => {
            ttsSpeakRaw('Bat Out Of Hell. Voice test.');
        });

        function syncCheckboxesFromState() {
            verbItems.checked = verbosity.items;
            verbPowerups.checked = verbosity.powerups;
            verbSinkholes.checked = verbosity.sinkholes;
            verbSpeed.checked = verbosity.speed;
            verbLanes.checked = verbosity.lanes;
            tiltEnabledEl.checked = controlsOptions.tiltEnabled;
            syncTtsFromState();
        }
        syncCheckboxesFromState();

        let optionsLastFocused = null;

        function openOptions() {
            optionsLastFocused = document.activeElement;
            syncCheckboxesFromState();
            optionsModal.hidden = false;
            // Move focus into the dialog so SR users land on the title/close.
            optionsClose.focus();
        }

        function closeOptions() {
            optionsModal.hidden = true;
            if (optionsLastFocused && typeof optionsLastFocused.focus === 'function') {
                optionsLastFocused.focus();
            }
        }

        optionsBtn.addEventListener('click', openOptions);
        optionsClose.addEventListener('click', closeOptions);

        // Click on backdrop (but not the panel) closes the dialog.
        optionsModal.addEventListener('click', (e) => {
            if (e.target === optionsModal) closeOptions();
        });

        // Escape closes the dialog without affecting pause state (the global
        // Escape handler in input-rumble-gamepad.js only acts when gameRunning).
        optionsModal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                closeOptions();
            }
        });

        function bindCheckbox(el, key) {
            el.addEventListener('change', () => {
                verbosity[key] = !!el.checked;
                saveOptions();
            });
        }
        bindCheckbox(verbItems, 'items');
        bindCheckbox(verbPowerups, 'powerups');
        bindCheckbox(verbSinkholes, 'sinkholes');
        bindCheckbox(verbSpeed, 'speed');
        bindCheckbox(verbLanes, 'lanes');

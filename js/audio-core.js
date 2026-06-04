        // syngen.mixer is bypassed in this game. Mixing engine audio and
        // binaural-processed prop audio at the same node (syngen.mixer.input)
        // produced a ducking artifact we couldn't trace inside the mixer chain
        // even with the master limiter neutralised. omega-reach (the reference
        // syngen game) avoids the issue by wrapping syngen.mixer in a small
        // channel layer where every sound gets its own sub-bus, and by using
        // StereoPanner for positioning instead of syngen.ear.binaural. We do
        // the same here.
        // ===== Peak metering =====
        // True-peak meters tap arbitrary points in the graph via AnalyserNode
        // (which is non-destructive — it observes whatever is connected to it
        // without altering the signal). Each meter holds the running peak
        // sample magnitude until reportPeaks() reads + resets it. Sampling is
        // driven by an independent rAF loop so it works regardless of
        // gameRunning / paused. Master peak is observed by routing every
        // channel output (and the reverb returns) in parallel into a single
        // analyser; this is the correct way to get the true summed signal,
        // since the underlying AudioParams add at the analyser node just like
        // they do at ac.destination.
        const peakMeters = [];
        function makePeakMeter(label) {
            const ac = syngen.context();
            const node = ac.createAnalyser();
            node.fftSize = 2048;
            const buf = new Float32Array(node.fftSize);
            let peak = 0;
            const meter = {
                label,
                node,
                sample() {
                    node.getFloatTimeDomainData(buf);
                    let m = 0;
                    for (let i = 0; i < buf.length; i++) {
                        const a = Math.abs(buf[i]);
                        if (a > m) m = a;
                    }
                    if (m > peak) peak = m;
                },
                readAndReset() {
                    const p = peak;
                    peak = 0;
                    return p;
                },
            };
            peakMeters.push(meter);
            return meter;
        }

        const audioChannels = (() => {
            const ac = syngen.context();
            function createChannel(name, gain = 0.8, { filter = false } = {}) {
                const input = ac.createGain();
                const output = ac.createGain();
                output.gain.value = gain;
                let filterNode = null;
                if (filter) {
                    // Lowpass placed between input and output. Default ~22 kHz
                    // is effectively bypass; callers ramp .frequency down to
                    // muffle the channel (e.g. ground props while airborne).
                    filterNode = ac.createBiquadFilter();
                    filterNode.type = 'lowpass';
                    filterNode.frequency.value = 22050;
                    filterNode.Q.value = 0.7;
                    input.connect(filterNode).connect(output);
                } else {
                    input.connect(output);
                }
                output.connect(ac.destination);
                // Channel-level meter taps post-fader output in parallel.
                const channelMeter = makePeakMeter(`channel:${name}`);
                output.connect(channelMeter.node);
                let busSeq = 0;
                return {
                    input,
                    output,
                    filter: filterNode,
                    baseGain: gain,
                    createBus: (label) => {
                        const g = ac.createGain();
                        const id = label || `${name}#${++busSeq}`;
                        const meter = makePeakMeter(`source:${id}`);
                        g.connect(meter.node).connect(input);
                        // Wrap disconnect so the analyser is removed from the
                        // sampler registry when the bus is torn down. Without
                        // this, every spawned prop leaks an AnalyserNode that
                        // the rAF loop still polls (getFloatTimeDomainData on
                        // 2048 samples each, 60 Hz) — over a long run those
                        // dead meters dominate CPU. Wrapper is idempotent: a
                        // second disconnect() call is a no-op for the meter.
                        const origDisconnect = g.disconnect.bind(g);
                        let released = false;
                        g.disconnect = function (...args) {
                            if (!released) {
                                released = true;
                                try { meter.node.disconnect(); } catch (e) {}
                                const idx = peakMeters.indexOf(meter);
                                if (idx >= 0) peakMeters.splice(idx, 1);
                            }
                            return origDisconnect(...args);
                        };
                        return g;
                    },
                    param: { gain: output.gain },
                };
            }
            // Channel gains balance against each other and the master peak
            // budget (~-3 dBFS target). Default carries the engine + cues so
            // it sets the floor; props/groundProps were measured ~14-26 dB
            // below default, so they're bumped to bring obstacles and pickups
            // into the same perceptual range without endangering master.
            return {
                default: createChannel('default', 0.8),
                props: createChannel('props', 2.5),
                groundProps: createChannel('groundProps', 1.6, { filter: true }),
            };
        })();

        // Master meter — receives parallel taps from each channel output
        // and the reverb returns below. This is what sums to ac.destination,
        // so its peak is the true clipping reference.
        const masterMeter = makePeakMeter('master');
        audioChannels.default.output.connect(masterMeter.node);
        audioChannels.props.output.connect(masterMeter.node);
        audioChannels.groundProps.output.connect(masterMeter.node);

        // Seeded PRNG (mulberry32). Declared early so module-init noise buffers
        // (reverb IR, gas-can noise) can use it. Reseeded in startGame() with the
        // wall clock so each run diverges.
        let rngState = 1;
        function seedRng(s) { rngState = (s >>> 0) || 1; }
        function rand() {
            rngState = (rngState + 0x6D2B79F5) >>> 0;
            let t = rngState;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }

        // Reverb — synthetic IR (exponential-decay stereo noise) models a large
        // open outdoor space without being cavernous. RT60 ≈ 1.5 s, pre-delay
        // 20 ms simulates early reflections off road surface / barriers.
        // Tapped post-fader from both channels so the send level scales with
        // the channel faders; return sits -18 dB below dry to preserve the
        // stereo panning cues that matter for gameplay.
        const reverb = (() => {
            const ac = syngen.context();
            const duration = 1.6;   // seconds — covers RT60 tail comfortably
            const k = 3.85;          // decay constant: RT60 = ln(1000)/k ≈ 1.53 s
            const len = Math.floor(ac.sampleRate * duration);
            const ir = ac.createBuffer(2, len, ac.sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const d = ir.getChannelData(ch);
                for (let i = 0; i < len; i++) {
                    d[i] = (rand() * 2 - 1) * Math.exp(-k * i / ac.sampleRate);
                }
            }
            const convolver = ac.createConvolver();
            convolver.buffer = ir;
            const preDelay = ac.createDelay(0.1);
            preDelay.delayTime.value = 0.020;   // 20 ms early-reflection gap
            // Slow LFO modulates the delay into the convolver by ±4 ms so the
            // reverb tail varies slightly over time instead of repeating the same
            // static smear on flat-RPM driving.
            const shimmerDelay = ac.createDelay(0.02);
            shimmerDelay.delayTime.value = 0.006;
            const shimmerLfo = ac.createOscillator();
            shimmerLfo.type = 'sine';
            shimmerLfo.frequency.value = 0.27;
            const shimmerDepth = ac.createGain();
            shimmerDepth.gain.value = 0.004;
            shimmerLfo.connect(shimmerDepth).connect(shimmerDelay.delayTime);
            shimmerLfo.start();
            const returnGain = ac.createGain();
            returnGain.gain.value = syngen.fn.fromDb(-12);
            preDelay.connect(shimmerDelay).connect(convolver).connect(returnGain).connect(ac.destination);
            returnGain.connect(masterMeter.node);
            const reverbMeter = makePeakMeter('reverb:outdoor');
            returnGain.connect(reverbMeter.node);
            const send = ac.createGain();
            send.connect(preDelay);
            // Per-sound send helper. Creates a gain node at gainDb that feeds the
            // shared junction so callers can set their own reverb contribution level.
            function createSend(gainDb = 0) {
                const g = ac.createGain();
                g.gain.value = syngen.fn.fromDb(gainDb);
                g.connect(send);
                return g;
            }
            return { send, createSend };
        })();

        audioChannels.props.output.connect(reverb.send);
        audioChannels.groundProps.output.connect(reverb.send);

        // Parallel tunnel reverb — a second convolver with a longer, brighter
        // tail (RT60 ~5 s, no shimmer LFO) used only inside tunnels. Lives in
        // parallel with the outdoor reverb above; both are always running, and
        // the tunnel system crossfades `tunnelReverb.wet` 0→1 on enter and
        // 1→0 on exit. We can't smoothly mutate a ConvolverNode's buffer
        // (reassigning .buffer truncates the live tail and clicks), so a
        // parallel bus + GainNode crossfade is the artifact-free path.
        const tunnelReverb = (() => {
            const ac = syngen.context();
            const duration = 5.0;
            const k = 1.38;  // RT60 = ln(1000)/k ≈ 5.0 s
            const len = Math.floor(ac.sampleRate * duration);
            const ir = ac.createBuffer(2, len, ac.sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const d = ir.getChannelData(ch);
                for (let i = 0; i < len; i++) {
                    d[i] = (rand() * 2 - 1) * Math.exp(-k * i / ac.sampleRate);
                }
            }
            const convolver = ac.createConvolver();
            convolver.buffer = ir;
            const preDelay = ac.createDelay(0.1);
            preDelay.delayTime.value = 0.035;   // longer ER gap reads as "bigger room"
            const returnGain = ac.createGain();
            returnGain.gain.value = syngen.fn.fromDb(-6);
            const wet = ac.createGain();
            wet.gain.value = 0;   // closed until tunnel enter
            const send = ac.createGain();
            send.connect(preDelay).connect(convolver).connect(returnGain).connect(wet);
            wet.connect(ac.destination);
            wet.connect(masterMeter.node);
            const tunnelReverbMeter = makePeakMeter('reverb:tunnel');
            wet.connect(tunnelReverbMeter.node);
            function createSend(gainDb = 0) {
                const g = ac.createGain();
                g.gain.value = syngen.fn.fromDb(gainDb);
                g.connect(send);
                return g;
            }
            return { send, createSend, wet };
        })();

        // Channel-level tap: every prop sound already routes through these
        // channel outputs, so one connection apiece feeds them all into the
        // tunnel reverb. Master wet gain stays at 0 until tunnel.enter ramps
        // it open, so this connection is silent outside tunnels.
        audioChannels.props.output.connect(tunnelReverb.send);
        audioChannels.groundProps.output.connect(tunnelReverb.send);

        // Anything that previously connected to syngen.mixer.input() (engine,
        // horn, one-shot cues) now lands on the default channel input.
        syngen.mixer.input = () => audioChannels.default.input;

        // Drive the meter sampling on rAF — independent of the syngen frame
        // loop and the gameRunning gate so reportPeaks() works in the menu
        // too. fftSize=2048 / 60 Hz ≈ ~43 ms per sample window at 48 kHz, so
        // we miss short transients in between rAFs; per-source peak-hold
        // accumulates across calls between reports, so a multi-second window
        // of normal gameplay captures every real peak with high confidence.
        (function startPeakSampler() {
            function tick() {
                for (let i = 0; i < peakMeters.length; i++) peakMeters[i].sample();
                requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        })();

        // Hotkey-triggered report (bound on M in input-rumble-gamepad.js).
        // Reads + resets every meter, logs a sorted table to the console for
        // detail, and announces master peak + headroom via the screen-reader
        // live region.
        function reportPeaks() {
            const rows = peakMeters.map(m => {
                const linear = m.readAndReset();
                const dbfs = linear > 0 ? 20 * Math.log10(linear) : -Infinity;
                return { label: m.label, linear, dbfs };
            });
            rows.sort((a, b) => b.dbfs - a.dbfs);
            // Filter out silent meters so the table isn't dominated by stale
            // analyser nodes from destroyed prop sounds (each ephemeral bus
            // leaves its meter behind in the registry).
            const audible = rows.filter(r => r.dbfs !== -Infinity);
            const silentCount = rows.length - audible.length;
            const pretty = audible.map(r => ({
                source: r.label,
                peak: r.linear.toFixed(4),
                dBFS: r.dbfs.toFixed(1),
                headroomDb: (-r.dbfs).toFixed(1),
            }));
            // eslint-disable-next-line no-console
            console.table(pretty);
            if (silentCount > 0) {
                // eslint-disable-next-line no-console
                console.log(`(${silentCount} silent meter${silentCount === 1 ? '' : 's'} omitted)`);
            }
            const master = rows.find(r => r.label === 'master');
            if (master) {
                if (master.dbfs === -Infinity) {
                    announce('Master peak silent since last reading.');
                } else {
                    const db = master.dbfs.toFixed(1);
                    const head = (-master.dbfs).toFixed(1);
                    announce(`Master peak ${db} dBFS, ${head} dB headroom. Source breakdown in console.`);
                }
            }
        }

// import the modules
import { BasicMIDI } from './libraries/spessasynth_core_dist/index.js';
import { getPauseSvg, getPlaySvg, getFileOpenSvg, getFileHistorySvg, getForwardSvg, getBackwardSvg } from './js/icons.js';
import { WAV_NROFCHANNELS, WAV_BITSPERSAMPLE, WAV_SAMPLERATE, WAV_HEADERSIZE } from "./constants.js";

const VERSION = "v3.0.0dev26"
const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel

const _singleTabAllowed = await (async () => {
    if ('locks' in navigator) {
        return new Promise(resolve => {
            navigator.locks.request('midi-player-single-tab', { ifAvailable: true }, lock => {
                if (!lock) { resolve(false); return; }
                resolve(true);
                return new Promise(() => {}); // hold lock until tab is closed
            });
        });
    }
    return true;
})();

if (!_singleTabAllowed) {
    document.body.innerHTML = '<p style="font-family:sans-serif;padding:2rem">This app is already open in another tab. Please close this tab.</p>';
    throw new Error('App already open in another tab.');
}
const ICON_SIZE_PX = 24; // size of button icons
const MAXNROFRECENTFILES = 10; // Maximum number of recently opened files that can be stored in the cache
const SKIPFORWARD_SECONDS = 10; // skip audio forwards in seconds
const SKIPBACKWARD_SECONDS = 10; // skip audio backwards in seconds


async function generateHash(fileBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-1', fileBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

function promptForUpdate(worker) {
    if (document.getElementById("update")) return; // banner already showing
    appendAlert(
        `A new update of the app is available. When you dismiss this message or restart the app, the update is installed.`,
        'warning', "update",
        () => {
            console.log("Posting skipWaiting to service worker.");
            appendAlert("Update installing... When the installation has finished, the app will be reloaded automatically",'warning', "update");
            worker.postMessage({ type: 'skipWaiting'});
        }
    );
}

// iOS starts its own service worker update check on navigation, before register()
// resolves and before an "updatefound" listener can be attached. Because the
// install phase is slow (it re-downloads the soundfonts), the new worker is then
// typically found in registration.installing - "updatefound" has already fired and
// was missed. So besides listening for "updatefound", explicitly inspect the
// installing and waiting slots at startup and whenever the app regains visibility.
const watchedWorkers = new WeakSet();

function watchInstallingWorker(registration, worker) {
    if (watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);
    worker.addEventListener("statechange", (e) => {
        // registration.active distinguishes an update from the very first install.
        // (navigator.serviceWorker.controller is unreliable for this: iOS sometimes
        // launches an installed home-screen app uncontrolled.)
        if (e.target.state === "installed" && registration.active) {
            console.log("main: Service worker installed");
            promptForUpdate(worker);
        }
    });
}

function checkForUpdatedWorker(registration) {
    if (!registration.active) return; // first install, not an update
    if (registration.waiting) {
        console.log("main: Found a service worker already waiting");
        promptForUpdate(registration.waiting);
    } else if (registration.installing) {
        console.log("main: Found a service worker already installing");
        watchInstallingWorker(registration, registration.installing);
    }
}

if ("serviceWorker" in navigator) {
    // Register a service worker hosted at the root of the
    // site using the default scope.
    navigator.serviceWorker.register("./service-worker.js").then(
        (registration) => {
            console.log("Service worker registration succeeded:", registration);
            checkForUpdatedWorker(registration);
            registration.addEventListener("updatefound", () => {
                const installingWorker = registration.installing;
                console.log(`A new service worker is being installed: ${installingWorker}`);
                if (installingWorker) watchInstallingWorker(registration, installingWorker);
            });
            registration.update(); // Check for updates immediately on load
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") {
                    registration.update();
                    checkForUpdatedWorker(registration);
                }
            });
        },
        (error) => {
            console.error(`Service worker registration failed: ${error}`);
        },
    );
} else {
    console.error("Service workers are not supported.");
}

let reloadingForUpdate = false;
function reloadForUpdate() {
    // "controllerchange" and the service worker's 'activated' message can both fire
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    console.log("A new service worker has taken control. Reloading the page");
    window.location.reload();
}

navigator.serviceWorker.addEventListener("controllerchange", reloadForUpdate);

const dedicatedWorker = new Worker('./dedicated-worker.js', {type: "module"});
dedicatedWorker.onerror = e => console.error("WORKER ERROR:", e.message, e);
dedicatedWorker.onmessageerror = e => console.error("WORKER MESSAGE ERROR:", e);
window.dedicatedWorker = dedicatedWorker;

console.log("dedicated worker created");
navigator.serviceWorker.addEventListener("message", (event) => {
    const { data, ports } = event;
    const portFromSW = ports && ports[0];
    if (!data) return;
    if (data.type === 'AUDIO_RANGE_REQ') {
        if (!portFromSW) return;
        console.log(`received ${data.type} message in main.js`);
        dedicatedWorker.postMessage(data, [portFromSW]);
    } else if (data.type === 'DEBUG') {
        appendAlert(data.message, 'info', 'debug');
    } else if (data.type === 'activated') {
        // Fallback: iOS does not reliably fire "controllerchange" after skipWaiting()
        reloadForUpdate();
    }
});

// Function to store settings
async function storeSettings(key, settings) {
    if (!navigator.serviceWorker.controller) return;
    console.log(`storing settings (key: ${key}`);
    if (key === "current_midi_file") {
        const fileURL = URL.createObjectURL(settings); // URL revoked in service worker
        await Promise.all([
            postStoreSettingsMessage(key, fileURL),
            postStoreSettingsMessage("current_midi_file_name", settings.name), // file info is not stored in objectURL, only the blob info.
        ]);
    } else if (key.startsWith("blob_")) { // store file
        const fileURL = URL.createObjectURL(settings); // URL revoked in service worker
        await postStoreSettingsMessage(key, fileURL);
    } else {
        await postStoreSettingsMessage(key, settings);
    }

    function postStoreSettingsMessage(key, settings) {
        return new Promise((resolve) => {
            const messageChannel = new MessageChannel();
            messageChannel.port1.onmessage = (e) => {
                console.log(`main: ${e.data}`);
                resolve();
            };
            navigator.serviceWorker.controller.postMessage({
                type: 'storeSettings',
                key: `./settings/${key}`,
                settings: settings
            }, [messageChannel.port2]);
        });
    }
}

// Function to delete settings
function deleteSettings(key) {
    if (!navigator.serviceWorker.controller) return;
    console.log(`deleting settings (key: ${key}`);
    navigator.serviceWorker.controller.postMessage({
        type: 'deleteFromCache',
        key: `./settings/${key}`
    });
}

// Function to retrieve settings
async function retrieveSettings(key) {
    try {
        if (!navigator.serviceWorker.controller) return null;
        if (key === "all") {
            return new Promise((resolve) => {
                const messageChannel = new MessageChannel();
                messageChannel.port1.onmessage = async (e) => {
                    const responseArray = e.data;
                    messageChannel.port1.close();
                    resolve(responseArray === null ? null : await Promise.all(responseArray));
                };
                navigator.serviceWorker.controller.postMessage({
                    type: "all",
                    key: undefined,
                    settings: undefined
                }, [messageChannel.port2]);
            });
        }
        const response = await fetch(`./settings/${key}`);
        if (key === "current_midi_file") {
            const nameResponse = await fetch(`./settings/current_midi_file_name`);
            if (!response.ok || !nameResponse.ok) return null;
            const fileName = await nameResponse.json();
            const fileBlob = await response.blob();
            URL.revokeObjectURL(response.url);
            return new File([fileBlob], fileName, { type: fileBlob.type });
        }
        if (key.startsWith("blob_")) {
            if (!response.ok) return null;
            const fileBlob = await response.blob();
            URL.revokeObjectURL(response.url);
            return new File([fileBlob], key, { type: fileBlob.type });
        }
        return response.ok ? response.json() : null;
    } catch (error) {
        console.error(error);
        return null;
    }
}

const alertPlaceholder = document.getElementById('alertPlaceholder');
const appendAlert = (message, type, id, callback) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = [
        `<div id=${id} class="alert alert-${type} alert-dismissible" role="alert">`,
        `   <div>${message}</div>`,
        '   <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>',
        '</div>'
    ].join('');
    alertPlaceholder.append(wrapper);
    if (callback !== undefined) {
        const alert = document.getElementById(id);
        alert.addEventListener('closed.bs.alert', (event) => { callback(event); });
    }
}

document.getElementById('version').textContent = VERSION;
document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
document.getElementById("midi_input-label").innerHTML = getFileOpenSvg(ICON_SIZE_PX);
document.getElementById("history-label").innerHTML = getFileHistorySvg(ICON_SIZE_PX);
document.getElementById("forward-label").innerHTML = getForwardSvg(ICON_SIZE_PX);
document.getElementById("backward-label").innerHTML = getBackwardSvg(ICON_SIZE_PX);

const audioElement = document.getElementById("audioElement");
console.log("audioElement created");

// In an installed (standalone) web app, iOS suspends the web process shortly after audio pauses
// while the screen is locked, so the lock-screen play command never reaches the page
// (https://bugs.webkit.org/show_bug.cgi?id=261858). Keeping an inaudible loop playing on a second
// audio element holds the audio session open, so the process stays alive and playback can resume.
const IS_STANDALONE = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const KEEPALIVE_MAX_MS = 5 * 60 * 1000; // [ms] battery guard: stop the keep-alive loop this long after the last pause; iOS may then suspend the app and resuming requires reopening it
const keepAliveAudio = IS_STANDALONE ? createKeepAliveAudio() : null;
let keepAliveTimer = null;

function createKeepAliveAudio() {
    const sampleRate = 8000;
    const freqHz = 1000; // DEBUG: audible 1kHz tone instead of silence, to hear when the keep-alive loop is actually playing
    const numSamples = sampleRate; // 1 second, looped. sampleRate/freqHz = 8 samples/cycle divides evenly into numSamples, so sample 0 and sample numSamples are both zero-crossing/ascending -> seamless loop
    const amplitude = 12.7; // ~10% of the 8-bit dynamic range (127)
    const wav = new Uint8Array(WAV_HEADERSIZE + numSamples);
    const view = new DataView(wav.buffer);
    const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) { wav[offset + i] = str.charCodeAt(i); } };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + numSamples, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true); // byte rate: sampleRate * 1 channel * 1 byte
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // bits per sample
    writeString(36, "data");
    view.setUint32(40, numSamples, true);
    for (let i = 0; i < numSamples; i++) {
        wav[WAV_HEADERSIZE + i] = 128 + Math.round(amplitude * Math.sin(2 * Math.PI * freqHz * i / sampleRate));
    }
    const audio = new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
    audio.loop = true;
    return audio;
}

// iOS (observed on 26.5) refuses to start the silent loop once the lock screen is shown, so it cannot
// be started from media session handlers triggered on the lock screen. Instead it is started while the
// app is in focus (on every in-app play) and kept playing across pauses; armKeepAliveStop() bounds how
// long it keeps running after a pause.
function startKeepAlive() {
    if (!keepAliveAudio) return;
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
    if (keepAliveAudio.paused) {
        keepAliveAudio.play().then(() => {
            console.log("main: keep-alive audio started");
        }).catch((err) => {
            console.log(`main: keep-alive audio failed to start: ${err.name}`);
        });
    }
}

function armKeepAliveStop() { // call when the main audio pauses: keep the loop running so the app survives the lock screen, but not forever
    if (!keepAliveAudio || keepAliveAudio.paused) return;
    clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(stopKeepAlive, KEEPALIVE_MAX_MS);
}

function stopKeepAlive() {
    if (!keepAliveAudio) return;
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
    if (!keepAliveAudio.paused) {
        keepAliveAudio.pause();
        console.log("main: keep-alive audio stopped");
    }
}

dedicatedWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'workerInitialised') {
        console.log("dedicated worker initialised");
        activateApplication(msg.instruments);
    } else if (msg.type === 'DEBUG') {
        appendAlert(msg.message, 'info', 'debug');
    }
};
console.log("dedicate worker's onmessage defined");

async function activateApplication(instruments) {
    const progressSlider = document.getElementById("progress");
    progressSlider.BeingDragged = false;
    const totalTimeDisplay = document.getElementById('totalTime');
    const playbackRateInput = document.getElementById('playbackRate');
    const playbackRateValue = document.getElementById('playbackRateValue');
    const currentTimeDisplay = document.getElementById('currentTime');
    document.getElementById("midi_input").disabled = false;
    document.getElementById("message").innerText = "open midi file";

    let settings;
    let currentPlaybackRate = 1;
    let currentTime = 0;
    let progressAbortController = null;
    setEventListenersAudioElement();

    async function setupApplication() {
        const buffer = await file.arrayBuffer();
        const midiFileHash = await generateHash(buffer);
        const midi = BasicMIDI.fromArrayBuffer(buffer, file.name);
        dedicatedWorker.postMessage({ type: 'LOAD_MIDI', buffer: buffer, name: file.name });

        setupProgressSliderEvents();
        setupPlaybackRateEvents();
        setupPlaybackButtons();

        document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
        progressSlider.max = Math.floor(midi.duration);
        totalTimeDisplay.textContent = formatTime(midi.duration);

        const channelControlsContainer = document.getElementById('channel-controls');
        const channelControlHeader = document.getElementById('channel-control-header');
        channelControlsContainer.innerHTML = channelControlHeader.outerHTML; // Clear existing controls except for the header

        settings = (await retrieveSettings(midiFileHash)) ?? createDefaultSettings(midi, midiFileHash);
        settings.midiName ??= midi.getName(); // ensure compatibility with old settings stored in cache
        settings.duration_s ??= midi.duration; // [s] midi duration. start of the file to `midi.lastVoiceEventTick`.
        settings.wavLength_bytes ??= Math.floor(midi.duration / settings.playbackRate * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE / 8) * WAV_NROFCHANNELS) + WAV_HEADERSIZE; // [bytes] length of wave file
        settings.lastOpened = Date.now();
        currentPlaybackRate = settings.playbackRate;

        document.getElementById("message").innerText = settings.midiName;
        document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
        playbackRateInput.value = settings.playbackRate;
        playbackRateValue.textContent = `${Number(settings.playbackRate).toFixed(2)}x`;

        const instrumentControls = new Map();
        for (const channel of settings.channels) {
            const isLastChannel = channel === settings.channels[settings.channels.length - 1];
            channelControlsContainer.appendChild(createChannelControl(channel, instrumentControls, isLastChannel));
        }

        await storeSettings(settings.midiFileHash, settings);

        currentTime = 0.0;
        progressSlider.value = 0;
        currentTimeDisplay.textContent = formatTime(0.0);
        audioElement.pause();
        audioElement.src = `./generatedWav/${settings.midiFileHash}_${self.crypto.randomUUID()}.wav`;
        audioElement.load();
        console.log(`main: AudioElement src set to ${audioElement.src}`);

        if ("mediaSession" in navigator) {
            setupMediaSession();
        }
    }

    function setupProgressSliderEvents() {
        progressSlider.oninput = () => {
            currentTimeDisplay.textContent = formatTime(Number(progressSlider.value));
        };

        if (progressAbortController) progressAbortController.abort();
        progressAbortController = new AbortController();
        const { signal } = progressAbortController;

        function releaseProgressSlider() {
            audioElement.currentTime = Number(progressSlider.value) / settings.playbackRate;
            progressSlider.BeingDragged = false;
            console.log("progress slider released");
        }

        progressSlider.addEventListener("pointerdown", () => {
            progressSlider.BeingDragged = true;
            console.log("progress slider clicked");
        }, { capture: true, signal });
        progressSlider.addEventListener("pointerup", releaseProgressSlider, { capture: false, signal });
        progressSlider.addEventListener("touchstart", () => {
            progressSlider.BeingDragged = true;
        }, { capture: true, signal }); // else it won't work on touch devices when dragging the slider
        progressSlider.addEventListener("touchcancel", releaseProgressSlider, { capture: false, signal }); // else it won't work on touch devices when dragging the slider
        progressSlider.addEventListener("touchend", releaseProgressSlider, { capture: false, signal }); // else it won't work on touch devices when dragging the slider
    }

    function setupPlaybackRateEvents() {
        playbackRateInput.oninput = () => {
            playbackRateValue.textContent = `${Number(playbackRateInput.value).toFixed(2)}x`;
        };
        playbackRateInput.onchange = async () => {
            playbackRateValue.textContent = `${Number(playbackRateInput.value).toFixed(2)}x`;
            if (settings?.midiFileHash !== undefined) {
                settings.playbackRate = playbackRateInput.value;
                settings.wavLength_bytes = Math.floor(settings.duration_s / settings.playbackRate * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE / 8) * WAV_NROFCHANNELS) + WAV_HEADERSIZE; // [bytes] length of wave file
                await storeSettings(settings.midiFileHash, settings);
            }
            updateAudioElement();
        };
    }

    function setupPlaybackButtons() {
        document.getElementById("pause").onclick = () => {
            if (document.getElementById("pause-label").innerHTML === getPlaySvg(ICON_SIZE_PX)) {
                document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);
                startKeepAlive(); // a user gesture with the app in focus: the only context where iOS lets the silent loop start
                audioElement.play().catch((err) => {
                    if (err.name === "AbortError") { return; } // play was cancelled. Should not throw an error
                    if (err.name === "NotAllowedError") { // audio will not play; revert the UI so it does not claim to be playing
                        document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
                        if ("mediaSession" in navigator) {
                            navigator.mediaSession.playbackState = "paused";
                        }
                        return;
                    }
                    else { throw err; }
                });
                if ("mediaSession" in navigator) {
                    navigator.mediaSession.setPositionState({ duration: settings.duration_s, position: audioElement.currentTime * settings.playbackRate });
                    navigator.mediaSession.playbackState = "playing";
                }
            } else {
                document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
                audioElement.pause();
                armKeepAliveStop();
                if ("mediaSession" in navigator) {
                    navigator.mediaSession.playbackState = "paused";
                    navigator.mediaSession.setPositionState({ duration: settings.duration_s, position: audioElement.currentTime * settings.playbackRate });
                }
            }
        };
        document.getElementById("forward").onclick = () => {
            audioElement.currentTime = Math.min((audioElement.currentTime * settings.playbackRate + SKIPFORWARD_SECONDS) / settings.playbackRate, audioElement.duration - 1);
        };
        document.getElementById("backward").onclick = () => {
            audioElement.currentTime = Math.max((audioElement.currentTime * settings.playbackRate - SKIPBACKWARD_SECONDS) / settings.playbackRate, 0);
        };
    }

    function setupMediaSession() {
        navigator.mediaSession.setActionHandler("pause", () => {
            document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
            audioElement.pause();
            armKeepAliveStop(); // the silent loop keeps running, so iOS does not suspend the app while paused on the lock screen
            navigator.mediaSession.playbackState = "paused";
        });
        navigator.mediaSession.setActionHandler("play", () => {
            document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);
            startKeepAlive(); // cancels the pending stop; a no-op start when the loop is already playing
            audioElement.play().catch((err) => {
                if (err.name === "AbortError") { return; } // play was cancelled. Should not throw an error
                if (err.name === "NotAllowedError") { // iOS refused to resume (e.g. suspended standalone app); revert the UI so it does not claim to be playing
                    document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
                    navigator.mediaSession.playbackState = "paused";
                    armKeepAliveStop(); // stay alive (bounded) so a next play attempt can still reach us
                    return;
                }
                else { throw err; }
            });
            navigator.mediaSession.playbackState = "playing";
        });
        navigator.mediaSession.setActionHandler("seekto", (evt) => {
            if (!evt?.fastSeek) {
                progressSlider.BeingDragged = false;
                audioElement.currentTime = evt.seekTime / settings.playbackRate;
            } else {
                progressSlider.BeingDragged = true;
            }
        });
        navigator.mediaSession.setActionHandler("nexttrack", () => {
            audioElement.currentTime = Math.min((audioElement.currentTime * settings.playbackRate + SKIPFORWARD_SECONDS) / settings.playbackRate, audioElement.duration - 1);
        });
        navigator.mediaSession.setActionHandler("previoustrack", () => {
            audioElement.currentTime = Math.max((audioElement.currentTime * settings.playbackRate - SKIPBACKWARD_SECONDS) / settings.playbackRate, 0);
        });
    }

    function createDefaultSettings(midi, midiFileHash) {
        const channelsPerTrack = midi.tracks.map(track => track.channels);
        const channelNumbers = new Set([...channelsPerTrack.flatMap(set => [...set])]); // unique channels in the midi file
        const trackNames = getTrackNames(midi);
        const channels = [];
        channelNumbers.forEach(channelNumber => {
            const trackNumber = channelsPerTrack.findIndex(set => set.has(channelNumber));
            channels.push({
                name: `${channelNumber}:${trackNames[trackNumber]}`,
                number: channelNumber,
                pan: Math.round((127 * channelNumber) / (channelNumbers.size - 1)), // automatically pans channels left to right [0,127], 64 = centre
                volume: 85,
                selectedInstrument: "Default"
            });
        });
        return {
            midiFileHash,
            midiName: midi.getName(),
            playbackRate: 1.0,
            duration_s: midi.duration,
            wavLength_bytes: Math.floor(midi.duration * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE / 8) * WAV_NROFCHANNELS) + WAV_HEADERSIZE,
            channels,
        };
    }

    function createChannelControl(channel, instrumentControls, lastChannel) {
        const container = document.createElement('div');
        container.className = lastChannel
            ? 'd-flex flex-row align-items-center mt-2 mb-2 w-100'
            : 'd-flex flex-row align-items-center mt-2 w-100';

        const nameLabel = document.createElement('div');
        nameLabel.className = 'd-flex ms-2 channel-name';
        nameLabel.innerText = channel.name;
        container.appendChild(nameLabel);

        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.className = 'form-range flex-grow-0 flex-shrink-1 ms-2 volume-control';
        volumeSlider.min = 0;
        volumeSlider.max = 127;
        volumeSlider.value = channel.volume;
        volumeSlider.onchange = async () => {
            channel.volume = parseInt(volumeSlider.value);
            if (settings?.midiFileHash !== undefined) {
                await storeSettings(settings.midiFileHash, settings);
            }
            updateAudioElement();
        };

        const column2 = document.createElement('div');
        column2.className = 'd-flex volume-control ms-2 flex-grow-0 flex-shrink-1';
        column2.appendChild(volumeSlider);
        container.appendChild(column2);

        const instrumentSelect = document.createElement('select');
        instrumentSelect.className = 'form-select';
        const defaultOption = document.createElement('option');
        defaultOption.value = "-1:0";
        defaultOption.textContent = "Default";
        defaultOption.selected = channel.selectedInstrument === "Default";
        instrumentSelect.appendChild(defaultOption);

        if (channel.number === DEFAULT_PERCUSSION_CHANNEL) {
            instrumentSelect.disabled = true; // percussion channel has a fixed instrument
        } else {
            for (const instrument of Object.values(instruments)) {
                const option = document.createElement('option');
                option.value = `${instrument.bank}:${instrument.program}`;
                option.textContent = instrument.name;
                option.selected = channel.selectedInstrument === instrument.name;
                instrumentSelect.appendChild(option);
            }
            instrumentSelect.onchange = async (event) => {
                for (const option of event.target.options) {
                    if (option.selected) channel.selectedInstrument = option.textContent;
                }
                console.log(`changing channel ${channel.number} to instrument ${event.target.value}`);
                if (settings?.midiFileHash !== undefined) {
                    await storeSettings(settings.midiFileHash, settings);
                }
                updateAudioElement();
            };
            instrumentControls.set(channel.number, instrumentSelect);
        }

        const column = document.createElement('div');
        column.className = 'd-flex instrument-select mx-2';
        column.appendChild(instrumentSelect);
        container.appendChild(column);

        return container;
    }

    function formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function updateAudioElement() {
        currentTime = audioElement.currentTime * currentPlaybackRate;
        audioElement.pause();
        audioElement.src = `./generatedWav/${settings.midiFileHash}_${self.crypto.randomUUID()}.wav`;
        audioElement.load();
        console.log(`main: AudioElement src set to ${audioElement.src}`);
    }

    let file = await retrieveSettings("current_midi_file");
    if (file) {
        setupApplication();
    }

    document.getElementById("midi_input").addEventListener("change", async event => {
        file = event.target.files[0];
        if (!file) return;
        if (!(file.type === 'audio/midi' || file.type === 'audio/x-midi' || file.type === 'audio/mid' || file.type === 'audio/midi-clip'
            || file.type === 'audio/rtp-midi' || file.type === 'audio/rtx' || file.type === 'audio/sp-midi')) {
            appendAlert("Incorrect file type. Select a midi file.", 'warning', 'fileError');
            return;
        }
        console.log("file opened");
        const midiFileHash = await generateHash(await file.arrayBuffer());
        await Promise.all([
            storeSettings("current_midi_file", file),
            storeSettings(`blob_${midiFileHash}`, file),
        ]);
        setupApplication();
    });

    const history = document.getElementById("history");
    history.addEventListener("click", async () => {
        console.log("retrieving recently opened files");
        const historyList = await retrieveSettings('all');
        console.log(historyList);
        const historyDropdown = document.getElementById("historyDropdown");
        historyDropdown.innerHTML = `<li><h5 class="dropdown-header">Recently opened songs</h5></li>\n`;
        if (!Array.isArray(historyList)) return;
        historyList.sort((a, b) => {
            if (!Object.hasOwn(a, "lastOpened")) return 1;
            if (!Object.hasOwn(b, "lastOpened")) return -1;
            return a.lastOpened > b.lastOpened ? -1 : 1;
        });
        historyList.forEach(async (item, index) => {
            if (index >= MAXNROFRECENTFILES) {
                console.log(`More than ${MAXNROFRECENTFILES} songs stored in cash. Removing ${item.midiFileHash} from cache.`);
                deleteSettings(`blob_${item.midiFileHash}`);
                deleteSettings(`${item.midiFileHash}`);
                return;
            }
            if (!Object.hasOwn(item, "lastOpened")) return; // unlikely to have a blob stored in the cache, because it has been copied from a previous cache.

            const li = document.createElement('li');
            li.innerHTML = `<a class="dropdown-item">${item.midiName}</a>`;
            li.midiFileHash = `${item.midiFileHash}`;
            li.onclick = async (event) => {
                const li = event.target.closest('li');
                console.log(`midihash: ${li.midiFileHash}`);
                file = await retrieveSettings(`blob_${li.midiFileHash}`);
                if (file === null) {
                    console.log(`blob_${li.midiFileHash} not found in cash`);
                    deleteSettings(`${li.midiFileHash}`);
                    appendAlert("File not found. Select a different file or open a new one.", 'warning', 'fileError');
                } else {
                    console.log(`blob_${li.midiFileHash} retrieved from cash`);
                    await storeSettings("current_midi_file", file);
                    setupApplication();
                }
            };
            historyDropdown.appendChild(li);
        });
    });

    function setEventListenersAudioElement() {
        audioElement.addEventListener("error", () => {
            console.log(`main: error event on AudioElement: ${audioElement.error.code}, ${audioElement.error.message}, ${audioElement.src}`);
        });
        audioElement.addEventListener("stalled", () => {
            console.log(`main: AudioElement stalled. Ready state: ${audioElement.readyState}, ${audioElement.src}`);
        });
        audioElement.addEventListener("suspend", () => {
            console.log(`main: AudioElement suspended. Ready state: ${audioElement.readyState}, ${audioElement.src}`);
        });
        audioElement.addEventListener("timeupdate", () => {
            if (!progressSlider.BeingDragged && audioElement.readyState >= 2) { // do not update the progress slider when it is dragged, or data is not available for the current playback position
                progressSlider.value = Math.floor(audioElement.currentTime * currentPlaybackRate);
                currentTimeDisplay.textContent = formatTime(audioElement.currentTime * currentPlaybackRate);
                if (("mediaSession" in navigator) && (audioElement.duration >= audioElement.currentTime)) {
                    navigator.mediaSession.setPositionState({ duration: settings.duration_s, position: audioElement.currentTime * currentPlaybackRate });
                }
            }
        });
        audioElement.addEventListener("ended", () => {
            console.log(`main: playing of source AudioElement ended. Ready state: ${audioElement.readyState}, ${audioElement.src}`);
            audioElement.currentTime = 0.0;
            progressSlider.value = 0;
            currentTimeDisplay.textContent = formatTime(0.0);
            document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
            audioElement.pause();
            armKeepAliveStop(); // when the song ends with the screen locked, stay alive (bounded) so the lock-screen play button keeps working
            if ("mediaSession" in navigator) {
                navigator.mediaSession.playbackState = "paused";
                navigator.mediaSession.setPositionState({ duration: settings.duration_s, position: 0 });
            }
        });
        audioElement.addEventListener("loadedmetadata", (event) => {
            currentPlaybackRate = settings.playbackRate; // tracks the rate of the audio currently streaming; settings.playbackRate is the intended rate
            console.log(`main: AudioElement meta data loaded: ${audioElement.readyState}, ${audioElement.src}`);
            const paused = document.getElementById("pause-label").innerHTML === getPlaySvg(ICON_SIZE_PX); // audioElement.paused is unreliable when buttons are bashed
            if (paused) { // first start it before pausing, else mediaSession element will not be shown
                audioElement.play()
                .then(() => {
                    audioElement.currentTime = currentTime / settings.playbackRate;
                    audioElement.pause();
                    if ("mediaSession" in navigator) { // else the mediaSession in the notification screen will be closed
                        navigator.mediaSession.metadata = new MediaMetadata({title: `${settings.midiName}`});
                        navigator.mediaSession.playbackState = "paused";
                        navigator.mediaSession.setPositionState({duration: settings.duration_s, position: audioElement.currentTime*settings.playbackRate});
                    }
                })
                .catch((err)=>{
                    if (err.name === "AbortError") { return; } // play was cancelled. Should not throw an error
                    else if (err.name === "NotAllowedError") { return; } // user did not do any GUI interaction, so the audio will not play.
                    else {
                        appendAlert( `main: ${err.name}`, 'danger', 'DEBUG');
                        throw err;
                    }
                });
            } else {
                audioElement.play()
                .then(() => {
                    audioElement.currentTime = currentTime / settings.playbackRate;
                })
                .catch((err)=>{
                    if (err.name === "AbortError") { return; } // play was cancelled. Should not throw an error
                    else if (err.name === "NotAllowedError") { return; } // user did not do any GUI interaction, so the audio will not play.
                    else {
                        appendAlert( `main: ${err.name}`, 'danger', 'DEBUG');
                        throw err;
                    }
                });
                if ("mediaSession" in navigator) { // else the mediaSession in the notification screen will be closed
                    navigator.mediaSession.metadata = new MediaMetadata({title: `${settings.midiName}`});
                    navigator.mediaSession.playbackState = "playing";
                    navigator.mediaSession.setPositionState({duration: settings.duration_s, position: audioElement.currentTime*settings.playbackRate});
                }
            }
        });
    }
}

function getTrackNames(parsedMIDI) {
    return parsedMIDI.tracks.map(track => track.name);
}

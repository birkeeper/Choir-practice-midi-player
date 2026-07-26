// import the modules
import { BasicMIDI } from '../libraries/spessasynth_core_dist/index.js';
import { getFileOpenSvg, getFileHistorySvg, getMicSvg, getStopSvg, getDownloadSvg, getNoteSvg } from '../js/icons.js';

const VERSION = "v3.0.1dev1"; // keep in sync with midi_player.js
const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel
const DEFAULT_MAIN_VOLUME = 100; // GM default value of the main volume controller (CC7); shown until the user changes it
const ICON_SIZE_PX = 24; // size of button icons
const MAXNROFRECENTFILES = 10; // Maximum number of recently opened files shown in the history

// The recorder only reads the cache: settings changed here are deliberately not stored, so recording a
// song never changes how the player plays it.
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("../service-worker.js").then(
        (registration) => console.log("Service worker registration succeeded:", registration),
        (error) => console.error(`Service worker registration failed: ${error}`)
    );
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
        const response = await fetch(`../settings/${key}`);
        if (key === "current_midi_file") {
            const nameResponse = await fetch(`../settings/current_midi_file_name`);
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
const appendAlert = (message, type, id) => {
    document.getElementById(id)?.closest('div.alert')?.remove(); // only one alert of every kind at a time
    const wrapper = document.createElement('div');
    wrapper.innerHTML = [
        `<div id=${id} class="alert alert-${type} alert-dismissible" role="alert">`,
        `   <div>${message}</div>`,
        '   <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>',
        '</div>'
    ].join('');
    alertPlaceholder.append(wrapper);
}

document.getElementById('version').textContent = VERSION;
document.getElementById("record-label").innerHTML = getMicSvg(ICON_SIZE_PX);
document.getElementById("download-label").innerHTML = getDownloadSvg(ICON_SIZE_PX);
document.getElementById("midi_input-label").innerHTML = getFileOpenSvg(ICON_SIZE_PX);
document.getElementById("history-label").innerHTML = getFileHistorySvg(ICON_SIZE_PX);
document.getElementById("player-link").innerHTML = getNoteSvg(ICON_SIZE_PX);

const recorderWorker = new Worker('./recorder-worker.js', { type: "module" });
recorderWorker.onerror = e => console.error("WORKER ERROR:", e.message, e);
recorderWorker.onmessageerror = e => console.error("WORKER MESSAGE ERROR:", e);
console.log("recorder worker created");

const progressSlider = document.getElementById("progress");
const currentTimeDisplay = document.getElementById('currentTime');
const totalTimeDisplay = document.getElementById('totalTime');
const messageDisplay = document.getElementById("message");
const recordLabel = document.getElementById("record-label");
const downloadLabel = document.getElementById("download-label");
const downloadAnchor = document.getElementById("downloadAnchor");
const sampleRateSelect = document.getElementById("outputSampleRate");
const channelModeSelect = document.getElementById("outputChannels");
const midiInput = document.getElementById("midi_input");
const historyButton = document.getElementById("history");

let file = null; // the midi file to record
let song = null; // { name, midiName, duration_s, channels }
let changedChannelSettings = new Map(); // channel number -> only the settings the user actually changed
let recording = false;
let recordingStart_ms = 0;

recorderWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'workerInitialised') {
        console.log("recorder worker initialised");
        activateApplication(msg.instruments);
    } else if (msg.type === 'progress') {
        showProgress(msg.recorded_s, msg.duration_s);
    } else if (msg.type === 'done') {
        finishRecording(msg);
    } else if (msg.type === 'cancelled') {
        recording = false;
        setControlsDisabled(false);
        recordLabel.innerHTML = getMicSvg(ICON_SIZE_PX);
        messageDisplay.innerText = song?.midiName ?? "open midi file";
        resetProgress();
    } else if (msg.type === 'error') {
        recording = false;
        setControlsDisabled(false);
        recordLabel.innerHTML = getMicSvg(ICON_SIZE_PX);
        messageDisplay.innerText = song?.midiName ?? "open midi file";
        appendAlert(`Recording failed: ${msg.reason}`, 'danger', 'recordError');
    }
};

async function activateApplication(instruments) {
    midiInput.disabled = false;
    messageDisplay.innerText = "open midi file";

    async function setupApplication() {
        const buffer = await file.arrayBuffer();
        const midi = BasicMIDI.fromArrayBuffer(buffer, file.name);
        recorderWorker.postMessage({ type: 'LOAD_MIDI', buffer: buffer, name: file.name });

        song = {
            name: file.name,
            midiName: midi.getName(),
            duration_s: midi.duration, // [s] start of the file to `midi.lastVoiceEventTick`
            channels: getChannels(midi)
        };
        changedChannelSettings = new Map(); // a newly opened file starts as the unmodified original
        clearDownload();

        messageDisplay.innerText = song.midiName;
        totalTimeDisplay.textContent = formatTime(song.duration_s);
        progressSlider.max = Math.max(1, Math.floor(song.duration_s));
        resetProgress();

        const channelControlsContainer = document.getElementById('channel-controls');
        const channelControlHeader = document.getElementById('channel-control-header');
        channelControlsContainer.innerHTML = channelControlHeader.outerHTML; // Clear existing controls except for the header
        for (const channel of song.channels) {
            const isLastChannel = channel === song.channels[song.channels.length - 1];
            channelControlsContainer.appendChild(createChannelControl(channel, isLastChannel));
        }
    }

    function getChannels(midi) {
        const channelsPerTrack = midi.tracks.map(track => track.channels);
        const channelNumbers = new Set([...channelsPerTrack.flatMap(set => [...set])]); // unique channels in the midi file
        const trackNames = midi.tracks.map(track => track.name);
        return [...channelNumbers].map(channelNumber => ({
            name: `${channelNumber}:${trackNames[channelsPerTrack.findIndex(set => set.has(channelNumber))]}`,
            number: channelNumber
        }));
    }

    // Records only what the user changed: a channel is absent from the map as long as its controls are
    // untouched, so the worker leaves that channel completely to the midi file.
    function changeChannelSetting(channelNumber, setting) {
        const changed = changedChannelSettings.get(channelNumber) ?? { number: channelNumber };
        changedChannelSettings.set(channelNumber, { ...changed, ...setting });
    }

    function createChannelControl(channel, lastChannel) {
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
        volumeSlider.value = changedChannelSettings.get(channel.number)?.volume ?? DEFAULT_MAIN_VOLUME;
        volumeSlider.onchange = () => {
            changeChannelSetting(channel.number, { volume: parseInt(volumeSlider.value) });
            clearDownload(); // the previous recording no longer matches the settings
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
        defaultOption.selected = true;
        instrumentSelect.appendChild(defaultOption);

        if (channel.number === DEFAULT_PERCUSSION_CHANNEL) {
            instrumentSelect.disabled = true; // percussion channel has a fixed instrument
            instrumentSelect.dataset.percussion = "true"; // stays disabled when the other controls are re-enabled
        } else {
            const selectedInstrument = changedChannelSettings.get(channel.number)?.selectedInstrument;
            for (const instrument of Object.values(instruments)) {
                const option = document.createElement('option');
                option.value = `${instrument.bank}:${instrument.program}`;
                option.textContent = instrument.name;
                option.selected = selectedInstrument === instrument.name;
                instrumentSelect.appendChild(option);
            }
            defaultOption.selected = selectedInstrument === undefined;
            instrumentSelect.onchange = (event) => {
                for (const option of event.target.options) {
                    if (!option.selected) continue;
                    // "Default" means: keep the instrument the midi file selects for this channel
                    changeChannelSetting(channel.number, {
                        selectedInstrument: option === defaultOption ? undefined : option.textContent
                    });
                }
                clearDownload();
            };
        }

        const column = document.createElement('div');
        column.className = 'd-flex instrument-select mx-2';
        column.appendChild(instrumentSelect);
        container.appendChild(column);

        return container;
    }

    document.getElementById("record").onclick = () => {
        if (recording) {
            recorderWorker.postMessage({ type: 'CANCEL' });
            messageDisplay.innerText = "cancelling...";
            return;
        }
        if (!song) {
            appendAlert("No midi file opened. Open a midi file first.", 'warning', 'fileError');
            return;
        }
        recording = true;
        recordingStart_ms = Date.now();
        clearDownload();
        setControlsDisabled(true);
        recordLabel.innerHTML = getStopSvg(ICON_SIZE_PX);
        resetProgress();
        recorderWorker.postMessage({
            type: 'RECORD',
            settings: {
                sampleRate: Number(sampleRateSelect.value),
                mono: channelModeSelect.value === "mono",
                channels: [...changedChannelSettings.values()]
            }
        });
    };

    document.getElementById("download").onclick = () => {
        if (downloadAnchor.href) downloadAnchor.click();
    };

    file = await retrieveSettings("current_midi_file"); // the file last opened in the player, if any
    if (file) {
        setupApplication();
    }

    midiInput.addEventListener("change", async event => {
        const selectedFile = event.target.files[0];
        if (!selectedFile) return;
        if (!(selectedFile.type === 'audio/midi' || selectedFile.type === 'audio/x-midi' || selectedFile.type === 'audio/mid' || selectedFile.type === 'audio/midi-clip'
            || selectedFile.type === 'audio/rtp-midi' || selectedFile.type === 'audio/rtx' || selectedFile.type === 'audio/sp-midi')) {
            appendAlert("Incorrect file type. Select a midi file.", 'warning', 'fileError');
            return;
        }
        console.log("file opened");
        file = selectedFile;
        setupApplication();
    });

    historyButton.addEventListener("click", async () => {
        console.log("retrieving recently opened files");
        const historyList = await retrieveSettings('all');
        const historyDropdown = document.getElementById("historyDropdown");
        historyDropdown.innerHTML = `<li><h5 class="dropdown-header">Recently opened songs</h5></li>\n`;
        if (!Array.isArray(historyList)) return;
        historyList.sort((a, b) => {
            if (!Object.hasOwn(a, "lastOpened")) return 1;
            if (!Object.hasOwn(b, "lastOpened")) return -1;
            return a.lastOpened > b.lastOpened ? -1 : 1;
        });
        historyList.forEach((item, index) => {
            if (index >= MAXNROFRECENTFILES) return; // cache housekeeping is left to the player
            if (!Object.hasOwn(item, "lastOpened")) return;

            const li = document.createElement('li');
            li.innerHTML = `<a class="dropdown-item">${item.midiName}</a>`;
            li.midiFileHash = `${item.midiFileHash}`;
            li.onclick = async (event) => {
                const li = event.target.closest('li');
                const historyFile = await retrieveSettings(`blob_${li.midiFileHash}`);
                if (historyFile === null) {
                    console.log(`blob_${li.midiFileHash} not found in cache`);
                    appendAlert("File not found. Select a different file or open a new one.", 'warning', 'fileError');
                } else {
                    file = historyFile;
                    setupApplication();
                }
            };
            historyDropdown.appendChild(li);
        });
    });
}

function showProgress(recorded_s, duration_s) {
    progressSlider.value = Math.floor(recorded_s);
    currentTimeDisplay.textContent = formatTime(recorded_s);
    messageDisplay.innerText = `recording... ${Math.floor(100 * recorded_s / duration_s)}%`;
}

function resetProgress() {
    progressSlider.value = 0;
    currentTimeDisplay.textContent = formatTime(0);
}

function finishRecording(msg) {
    recording = false;
    setControlsDisabled(false);
    recordLabel.innerHTML = getMicSvg(ICON_SIZE_PX);
    messageDisplay.innerText = song?.midiName ?? "";
    progressSlider.value = progressSlider.max;
    currentTimeDisplay.textContent = formatTime(msg.duration_s);

    clearDownload();
    const wavBlob = new Blob([msg.data], { type: "audio/wav" });
    downloadAnchor.href = URL.createObjectURL(wavBlob);
    downloadAnchor.download = wavFileName();
    downloadLabel.classList.remove("invisible");
    const recordingTime_s = (Date.now() - recordingStart_ms) / 1000;
    appendAlert(
        `Recorded ${formatTime(msg.duration_s)} of audio in ${recordingTime_s.toFixed(1)} s `
        + `(${msg.sampleRate / 1000} kHz, ${msg.nrOfChannels === 1 ? "mono" : "stereo"}, `
        + `${(wavBlob.size / (1024 * 1024)).toFixed(1)} MB). `
        + `Press the download button to save <b>${downloadAnchor.download}</b>.`,
        'success', 'recordReady'
    );
}

function clearDownload() {
    if (downloadAnchor.href) {
        URL.revokeObjectURL(downloadAnchor.href);
        downloadAnchor.removeAttribute("href");
    }
    downloadLabel.classList.add("invisible");
    document.getElementById("recordReady")?.closest('div.alert')?.remove();
}

function wavFileName() {
    const baseName = (song?.name ?? "recording").replace(/\.(mid|midi)$/i, "");
    return `${baseName.replace(/[\\/:*?"<>|]/g, '_')}.wav`;
}

function setControlsDisabled(disabled) {
    midiInput.disabled = disabled;
    historyButton.disabled = disabled;
    sampleRateSelect.disabled = disabled;
    channelModeSelect.disabled = disabled;
    document.getElementById("history-label").classList.toggle("disabled", disabled);
    document.getElementById("midi_input-label").classList.toggle("disabled", disabled);
    for (const control of document.querySelectorAll('#channel-controls input, #channel-controls select')) {
        control.disabled = disabled || control.dataset.percussion === "true";
    }
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

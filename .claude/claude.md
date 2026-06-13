*Structure application*
This is a PWA application that needs to run in browsers on iOS, Android, MacOS, Linux and Windows and also work offline. It is based on the SpessaSynth core library (./libraries/spessasynth_core)
./midi_player.html and ./midi_player.js is the GUI of the application. When the user selects a midi file, a wave file is loaded in the htmlAudioElement audioElement. The browser will then perform range requests to download the file. These range requests are captured in ./service-worker.js that sets up a ReadableStream. The generation of wave file chunks is handled by ./dedicated-worker.js. It returns the requested range.
If the user changes a setting for the midi playback another wave file is loaded. 
Each song gets its own UUID. Each range request gets its own session ID.
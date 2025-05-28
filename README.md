# Choir-practice-midi-player
The choir-practice-midi-player is a Web-based Midi player specifically targeted at choir practice. However, it is also usable for any musician to practice their own part in an arrangement. It aims to create a good auditory separation of the different midi channels of a user-provided midi file that contains a multi-vocal arrangement of the song that needs to be practiced. 
This separation of the parts in the arrangement, is achieved by panning the channels in the midi file and letting the user set the volume and select distinctive instruments for each track. The user can select the instruments from a customised, good quality soundfont. It contains a piano, clarinet and a unique set of solo vocal doo's and da's sung by singers of Vocal Group Jammin'. The vocals of a soprano, alto, tenor and bass singer are included. The interface has been designed to be simple, but effective for practice.
The implementation is a front-end to the excellent [spessasynth_lib](https://github.com/spessasus/SpessaSynth).

## Usage
Use this link [https://birkeeper.github.io/Choir-practice-midi-player/midi_player.html](https://birkeeper.github.io/Choir-practice-midi-player/midi_player.html) to start the midi player. It should work in many different browsers on many operating systems, including Android, iOS, Windows and MacOS. You should give your browser "Music and Audio" permissions to let the application function properly. The first time you run it, it takes some time to download the soundfont before you can interact with the application. A Wi-Fi connection is recommended to shorten the waiting time. After that the application will respond quicker, because the soundfont is stored in cache. After the installation, the application can also run offline.
It is possible to install the app to your home screen of your smartphone by using "Add to Home Screen". When you do that, it will behave more like a full screen app.

## Credits
- [spessasynth_lib](https://github.com/spessasus/SpessaSynth) - for the source code that helped implement functionality
- [singers of Vocal Group Jammin'](https://vg-jammin.weebly.com/) - for lending their voices for creating a solo voice soundfont
- [Polyphone](https://www.polyphone-soundfonts.com/) - for the soundfont testing and editing tool
- [Christian Collins](https://schristiancollins.com) - for the bundled GeneralUserGS soundfont
- [Bootstrap](https://getbootstrap.com/) - for the unified, responsive graphical interface across different devices

## License
Copyright © 2024-2025 Birkeeper. Licensed under the MIT License. Some parts have a different license. Please check the license file.



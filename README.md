IDE UNPAR App (unofficial)
==========================

This is the fork of the original Moodle App:

* Customized with UNPAR branding
* Auto-connects with UNPAR's IDE
* Somewhat regularly synchonized from moodlehq's `integration` branch
* Follow version numbering as in moodlehq

## To Release

Ensure you are using node version 14. There are plenty of options to manage
different versions of node in one device.

1. `npx ionic cordova build android --prod --release`
2. `$ANDROID_SDK_ROOT/build-tools/31.0.0/apksigner sign --ks ~/Downloads/idemobile-release-key.keystore platforms/android/app/build/outputs/apk/release/app-release-unsigned.apk` (SDK and keystore path to be adjusted)
3. Upload `app-release-unsigned.apk` to Google Play

## Moodle App

This is the primary repository of source code for the official mobile app for Moodle.

* [User documentation](https://docs.moodle.org/en/Moodle_app)
* [Developer documentation](http://docs.moodle.org/dev/Moodle_App)
* [Development environment setup](https://docs.moodle.org/dev/Setting_up_your_development_environment_for_the_Moodle_App)
* [Bug Tracker](https://tracker.moodle.org/browse/MOBILE)
* [Release Notes](https://docs.moodle.org/dev/Moodle_App_Release_Notes)

### License

[Apache 2.0](http://www.apache.org/licenses/LICENSE-2.0)

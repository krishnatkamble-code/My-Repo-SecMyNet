# SecMyNet Android App Skeleton

This folder contains a minimal Jetpack Compose Android app skeleton that is wired to the same SecMyNet API.

## Run

1. Open this folder in Android Studio.
2. Sync Gradle.
3. Use the `local` flavor for emulator development.
4. For a remote backend, open `android-app/gradle.properties` and set `API_BASE_URL_REMOTE` to your server address, for example:
   ```properties
   API_BASE_URL_REMOTE=http://192.168.1.100:3000
   ```
5. Select the `remoteDebug` build variant in Android Studio or run:
   ```bash
   ./gradlew :app:assembleRemoteDebug
   ```
6. Build and run the app on an emulator or Android device.

## Android 14 cellular test

For an out-of-band test, set `API_BASE_URL_REMOTE` to the public HTTPS URL of
the EC2 deployment, build `remoteDebug`, and disable Wi-Fi on the Android 14
device. Do not use the EC2 private IP or cleartext HTTP for this test. The
Flutter template in `mobile/flutter-template` includes FCM token registration;
the backend accepts those tokens at `POST /api/me/push-token` and sends admin
connection requests through Firebase Cloud Messaging.
